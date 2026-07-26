import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { QWEN_PROVENANCE_RE } from "./asr-provenance";

// "GGUF" little-endian. The header is the source of truth for a model's
// architecture: a Qwen text GGUF reports `general.architecture = "qwen35"` (or
// "qwen3"), a Gemma-4 text GGUF reports `"gemma4"`. The manifest `lineage.text`
// string is operator-authored and can drift from the bytes actually shipped, so
// the strict-release gate reads the architecture out of the GGUF itself.
const GGUF_MAGIC = 0x4655_4747;

// Eliza-1 is a Gemma-4 family release. Any text GGUF whose architecture does not
// start with `gemma` is a stand-in (the pre-cutover bundles shipped Qwen3.5).
const GEMMA_TEXT_ARCHITECTURE_RE = /^gemma/i;

const MAX_GGUF_HEADER_BYTES = 1 << 20; // 1 MiB — `general.architecture` is one of the first KV entries.

// GGUF metadata value-type tags (gguf spec v2/v3).
enum GgufType {
	Uint8 = 0,
	Int8 = 1,
	Uint16 = 2,
	Int16 = 3,
	Uint32 = 4,
	Int32 = 5,
	Float32 = 6,
	Bool = 7,
	String = 8,
	Array = 9,
	Uint64 = 10,
	Int64 = 11,
	Float64 = 12,
}

const SCALAR_BYTE_WIDTH: Partial<Record<GgufType, number>> = {
	[GgufType.Uint8]: 1,
	[GgufType.Int8]: 1,
	[GgufType.Uint16]: 2,
	[GgufType.Int16]: 2,
	[GgufType.Uint32]: 4,
	[GgufType.Int32]: 4,
	[GgufType.Float32]: 4,
	[GgufType.Bool]: 1,
	[GgufType.Uint64]: 8,
	[GgufType.Int64]: 8,
	[GgufType.Float64]: 8,
};

/**
 * Minimal forward-only GGUF header cursor. Every read is bounds-checked against
 * the buffer; an overrun throws so the public reader can fail closed (return
 * null) rather than mis-parse a truncated header.
 */
class GgufCursor {
	private offset = 0;
	constructor(private readonly buf: Buffer) {}

	private ensure(n: number): void {
		if (this.offset + n > this.buf.length) {
			throw new RangeError("gguf header truncated");
		}
	}

	u32(): number {
		this.ensure(4);
		const v = this.buf.readUInt32LE(this.offset);
		this.offset += 4;
		return v;
	}

	/** GGUF lengths/counts are u64; header-scale values fit in a JS number. */
	u64(): number {
		this.ensure(8);
		const v = this.buf.readBigUInt64LE(this.offset);
		this.offset += 8;
		if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new RangeError("gguf u64 exceeds safe integer range");
		}
		return Number(v);
	}

	string(): string {
		const len = this.u64();
		this.ensure(len);
		const s = this.buf.toString("utf8", this.offset, this.offset + len);
		this.offset += len;
		return s;
	}

	skip(n: number): void {
		this.ensure(n);
		this.offset += n;
	}

	/** Advance past one metadata value of the given type without decoding it. */
	skipValue(type: GgufType): void {
		const width = SCALAR_BYTE_WIDTH[type];
		if (width !== undefined) {
			this.skip(width);
			return;
		}
		if (type === GgufType.String) {
			this.skip(this.u64());
			return;
		}
		if (type === GgufType.Array) {
			const elemType = this.u32() as GgufType;
			const count = this.u64();
			const elemWidth = SCALAR_BYTE_WIDTH[elemType];
			if (elemWidth !== undefined) {
				this.skip(elemWidth * count);
				return;
			}
			for (let i = 0; i < count; i += 1) this.skipValue(elemType);
			return;
		}
		throw new RangeError(`unsupported gguf value type ${type}`);
	}
}

/**
 * Read `general.architecture` from a GGUF file header. Returns the architecture
 * string (e.g. `"gemma4"`, `"qwen35"`) or `null` when the file is missing,
 * unreadable, not a GGUF, or the key is absent. The reader fails closed (null)
 * so it can never *manufacture* a blocker from a parse failure.
 */
export function readGgufArchitecture(filePath: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const size = Math.min(statSync(filePath).size, MAX_GGUF_HEADER_BYTES);
		const buf = Buffer.allocUnsafe(size);
		const read = readSync(fd, buf, 0, size, 0);
		const cursor = new GgufCursor(buf.subarray(0, read));
		if (cursor.u32() !== GGUF_MAGIC) return null;
		cursor.u32(); // version
		cursor.u64(); // tensor_count
		const kvCount = cursor.u64();
		for (let i = 0; i < kvCount; i += 1) {
			const key = cursor.string();
			const type = cursor.u32() as GgufType;
			if (key === "general.architecture") {
				return type === GgufType.String ? cursor.string() : null;
			}
			cursor.skipValue(type);
		}
		return null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Blocker if a text GGUF's on-disk architecture is not Gemma-4. Eliza-1 is a
 * Gemma-4 release; a Qwen (or any non-Gemma) text model shipped under the
 * eliza-1 name is rejected so it can never become the default. By default an
 * unreadable architecture is not a blocker for loose/ad hoc scans; strict
 * release validation must pass `requireReadable: true`.
 */
export function collectTextArchitectureBlockers(
	textGgufPath: string,
	opts: { label?: string; requireReadable?: boolean } = {},
): string[] {
	const arch = readGgufArchitecture(textGgufPath);
	const rel = opts.label ?? path.basename(textGgufPath);
	if (arch === null) {
		return opts.requireReadable === true
			? [
					`files.text (${rel}): a strict/defaultEligible Eliza-1 release must ship a GGUF that reports Gemma-4 provenance (general.architecture missing or unreadable)`,
				]
			: [];
	}
	if (GEMMA_TEXT_ARCHITECTURE_RE.test(arch)) return [];
	if (QWEN_PROVENANCE_RE.test(arch)) {
		return [
			`files.text (${rel}): a strict/defaultEligible Eliza-1 release must ship the Gemma-4 text model, not a Qwen stand-in (general.architecture=${arch})`,
		];
	}
	return [
		`files.text (${rel}): a strict/defaultEligible Eliza-1 release must ship a Gemma-4 text model (general.architecture=${arch}, expected gemma*)`,
	];
}

function bundleTextGgufs(bundleRoot: string): string[] {
	const textDir = path.join(bundleRoot, "text");
	let entries: string[];
	try {
		entries = readdirSync(textDir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.toLowerCase().endsWith(".gguf"))
		.map((name) => path.join(textDir, name));
}

function resolveBundleTextPath(
	bundleRoot: string,
	manifestPath: string,
): { filePath?: string; blocker?: string } {
	if (!manifestPath || path.isAbsolute(manifestPath)) {
		return {
			blocker: `files.text (${manifestPath || "<empty>"}): invalid bundle-relative path`,
		};
	}
	const parts = manifestPath.split(/[\\/]+/);
	if (parts[0] !== "text" || !manifestPath.toLowerCase().endsWith(".gguf")) {
		return {
			blocker: `files.text (${manifestPath}): strict/defaultEligible Eliza-1 text entries must point at text/*.gguf`,
		};
	}
	const root = path.resolve(bundleRoot);
	const textRoot = path.join(root, "text");
	const filePath = path.resolve(root, manifestPath);
	if (filePath !== textRoot && !filePath.startsWith(textRoot + path.sep)) {
		return {
			blocker: `files.text (${manifestPath}): bundle path escapes text/`,
		};
	}
	return { filePath };
}

/**
 * Read every text GGUF staged under `<bundleRoot>/text/` and block any whose
 * architecture is not Gemma-4. The companion to `readBundleAsrProvenanceBlockers`
 * for the text model: the manifest's `lineage.text.base` is operator-authored,
 * this verifies the bytes that actually ship.
 *
 * When `manifestTextPaths` is provided, each manifest-declared text artifact is
 * required to exist under `text/` and expose a readable Gemma architecture.
 */
export function readBundleTextArchitectureBlockers(
	bundleRoot: string,
	manifestTextPaths?: ReadonlyArray<string>,
): string[] {
	if (manifestTextPaths !== undefined) {
		return manifestTextPaths.flatMap((manifestPath) => {
			const resolved = resolveBundleTextPath(bundleRoot, manifestPath);
			if (resolved.blocker) return [resolved.blocker];
			return collectTextArchitectureBlockers(resolved.filePath as string, {
				label: manifestPath,
				requireReadable: true,
			});
		});
	}
	return bundleTextGgufs(bundleRoot).flatMap(collectTextArchitectureBlockers);
}
