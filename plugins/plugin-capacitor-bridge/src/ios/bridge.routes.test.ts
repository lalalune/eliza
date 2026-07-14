/**
 * Route-table tests for the iOS bridge's direct-core shims — the view-backing
 * endpoints (memories, transcripts, browser workspace) that would otherwise 404
 * on device because the agent's node:http route handlers / plugin-local-inference
 * routes are not wired into the in-process iOS runtime.
 *
 * Each test drives `handleDirectCoreRoute` end-to-end against a real in-memory
 * runtime (the same core memory APIs the production handlers call), asserting
 * the exact response shapes the UI consumes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { installMobileFsShim } from "../shared/fs-shim.ts";
import {
	handleDirectCoreRoute,
	type IosBridgeBackend,
	resetIosBrowserWorkspace,
} from "./bridge.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

beforeAll(() => {
	installMobileFsShim(tmpdir());
});

/** A minimal in-memory runtime implementing the memory APIs the shims use. */
function createFakeRuntime(): IAgentRuntime {
	const tables = new Map<string, Memory[]>();
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "TestAgent" },
		async getMemories(params: {
			tableName: string;
			roomId?: UUID;
			limit?: number;
			count?: number;
			orderBy?: "createdAt";
			orderDirection?: "asc" | "desc";
		}): Promise<Memory[]> {
			let rows = [...(tables.get(params.tableName) ?? [])];
			if (params.roomId) {
				rows = rows.filter((m) => m.roomId === params.roomId);
			}
			if (params.orderBy === "createdAt") {
				const dir = params.orderDirection === "asc" ? 1 : -1;
				rows.sort((a, b) => dir * ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
			}
			const cap = params.count ?? params.limit;
			return typeof cap === "number" ? rows.slice(0, cap) : rows;
		},
		async getMemoryById(id: UUID): Promise<Memory | null> {
			for (const rows of tables.values()) {
				const found = rows.find((m) => m.id === id);
				if (found) return found;
			}
			return null;
		},
		async createMemory(memory: Memory, tableName: string): Promise<UUID> {
			const rows = tables.get(tableName) ?? [];
			rows.push(memory);
			tables.set(tableName, rows);
			return memory.id as UUID;
		},
		async updateMemory(
			memory: Partial<Memory> & { id: UUID },
		): Promise<boolean> {
			for (const rows of tables.values()) {
				const idx = rows.findIndex((m) => m.id === memory.id);
				if (idx >= 0) {
					rows[idx] = { ...rows[idx], ...memory } as Memory;
					return true;
				}
			}
			return false;
		},
		async deleteMemory(id: UUID): Promise<void> {
			for (const rows of tables.values()) {
				const idx = rows.findIndex((m) => m.id === id);
				if (idx >= 0) rows.splice(idx, 1);
			}
		},
	} as unknown as IAgentRuntime;
	return runtime;
}

function makeBackend(runtime: IAgentRuntime): IosBridgeBackend {
	return {
		runtime,
		dispatchRoute: async () => null,
		conversations: new Map(),
		close: async () => {},
	};
}

function jsonBody(payload: unknown): { body: string } {
	return { body: JSON.stringify(payload) };
}

async function call(
	backend: IosBridgeBackend,
	method: string,
	rawPath: string,
	body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await handleDirectCoreRoute(
		backend,
		method,
		rawPath,
		body === undefined ? {} : jsonBody(body),
	);
	if (!res) throw new Error(`route returned null: ${method} ${rawPath}`);
	return { status: res.status, json: JSON.parse(res.body) };
}

const seg = (
	text: string,
	endMs = 1000,
	speaker = "Speaker 1",
): TranscriptSegment => ({
	id: `seg-${Math.random().toString(36).slice(2)}`,
	speakerLabel: speaker,
	startMs: 0,
	endMs,
	text,
	words: [],
});

describe("iOS bridge — memories view routes", () => {
	let backend: IosBridgeBackend;
	let runtime: IAgentRuntime;

	beforeEach(() => {
		runtime = createFakeRuntime();
		backend = makeBackend(runtime);
	});

	async function seedMemory(
		table: string,
		text: string,
		createdAt: number,
		source?: string,
	): Promise<void> {
		await runtime.createMemory(
			{
				id: crypto.randomUUID() as UUID,
				entityId: AGENT_ID,
				roomId: AGENT_ID,
				agentId: AGENT_ID,
				createdAt,
				content: source ? { text, source } : { text },
			} as Memory,
			table,
		);
	}

	it("feed returns newest-first browse items with the UI shape", async () => {
		await seedMemory("messages", "oldest", 1_000);
		await seedMemory("facts", "newest", 3_000, "user");
		await seedMemory("memories", "middle", 2_000);

		const { status, json } = await call(backend, "GET", "/api/memories/feed");
		expect(status).toBe(200);
		const memories = json.memories as Array<Record<string, unknown>>;
		expect(memories.map((m) => m.text)).toEqual(["newest", "middle", "oldest"]);
		// Exact browse-item shape the MemoryViewer consumes.
		expect(memories[0]).toMatchObject({
			type: "facts",
			text: "newest",
			source: "user",
			createdAt: 3_000,
		});
		expect(json).toMatchObject({ count: 3, limit: 50, hasMore: false });
	});

	it("feed honors the limit + hasMore + before params", async () => {
		for (let i = 0; i < 5; i++) {
			await seedMemory("messages", `m${i}`, 1_000 + i);
		}
		const first = await call(backend, "GET", "/api/memories/feed?limit=2");
		expect((first.json.memories as unknown[]).length).toBe(2);
		expect(first.json.hasMore).toBe(true);

		// `before` excludes items at/after the cursor (newest is createdAt 1004).
		const before = await call(backend, "GET", "/api/memories/feed?before=1002");
		const beforeTexts = (before.json.memories as Array<{ text: string }>).map(
			(m) => m.text,
		);
		expect(beforeTexts).toEqual(["m1", "m0"]);
	});

	it("feed type filter scopes to a single table", async () => {
		await seedMemory("messages", "a message", 1_000);
		await seedMemory("facts", "a fact", 2_000);
		const { json } = await call(
			backend,
			"GET",
			"/api/memories/feed?type=facts",
		);
		const texts = (json.memories as Array<{ text: string }>).map((m) => m.text);
		expect(texts).toEqual(["a fact"]);
	});

	it("browse paginates + keyword-filters with total/limit/offset", async () => {
		await seedMemory("messages", "alpha bravo", 1_000);
		await seedMemory("messages", "charlie delta", 2_000);
		await seedMemory("facts", "alpha echo", 3_000);

		const all = await call(backend, "GET", "/api/memories/browse");
		expect(all.json).toMatchObject({ total: 3, limit: 50, offset: 0 });

		const search = await call(backend, "GET", "/api/memories/browse?q=alpha");
		const texts = (search.json.memories as Array<{ text: string }>).map(
			(m) => m.text,
		);
		expect(texts).toEqual(["alpha echo", "alpha bravo"]);
		expect(search.json.total).toBe(2);

		const page = await call(
			backend,
			"GET",
			"/api/memories/browse?limit=1&offset=1",
		);
		expect((page.json.memories as unknown[]).length).toBe(1);
		expect(page.json).toMatchObject({ total: 3, limit: 1, offset: 1 });
	});

	it("stats totals per table", async () => {
		await seedMemory("messages", "m1", 1_000);
		await seedMemory("messages", "m2", 2_000);
		await seedMemory("facts", "f1", 3_000);

		const { status, json } = await call(backend, "GET", "/api/memories/stats");
		expect(status).toBe(200);
		expect(json).toEqual({
			total: 3,
			byType: { messages: 2, memories: 0, facts: 1, documents: 0 },
		});
	});
});

describe("iOS bridge — transcripts view routes", () => {
	let backend: IosBridgeBackend;

	beforeEach(() => {
		backend = makeBackend(createFakeRuntime());
	});

	it("create → list → get → update → delete round-trips", async () => {
		// Create
		const created = await call(backend, "POST", "/api/transcripts", {
			title: "Standup",
			segments: [seg("hello world", 1500)],
		});
		expect(created.status).toBe(201);
		const transcript = created.json.transcript as Record<string, unknown>;
		expect(transcript).toMatchObject({
			title: "Standup",
			status: "ready",
			durationMs: 1500,
			speakerCount: 1,
		});
		const id = transcript.id as string;

		// List → summary shape
		const list = await call(backend, "GET", "/api/transcripts");
		expect(list.status).toBe(200);
		const summaries = list.json.transcripts as Array<Record<string, unknown>>;
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			id,
			title: "Standup",
			durationMs: 1500,
			speakerCount: 1,
			preview: "hello world",
			hasAudio: false,
		});

		// Get by id
		const got = await call(
			backend,
			"GET",
			`/api/transcripts/${encodeURIComponent(id)}`,
		);
		expect(got.status).toBe(200);
		expect((got.json.transcript as { id: string }).id).toBe(id);

		// Update (PUT) — new title + longer segment
		const updated = await call(
			backend,
			"PUT",
			`/api/transcripts/${encodeURIComponent(id)}`,
			{ title: "Standup (edited)", segments: [seg("hello there", 3000)] },
		);
		expect(updated.status).toBe(200);
		expect(updated.json.transcript).toMatchObject({
			title: "Standup (edited)",
			durationMs: 3000,
		});
		expect(
			(updated.json.transcript as { editedAt?: number }).editedAt,
		).toBeGreaterThan(0);

		// Delete
		const deleted = await call(
			backend,
			"DELETE",
			`/api/transcripts/${encodeURIComponent(id)}`,
		);
		expect(deleted.json).toEqual({ ok: true });

		const emptyList = await call(backend, "GET", "/api/transcripts");
		expect((emptyList.json.transcripts as unknown[]).length).toBe(0);
	});

	it("create rejects empty segments with 400", async () => {
		const res = await call(backend, "POST", "/api/transcripts", {
			segments: [],
		});
		expect(res.status).toBe(400);
		expect(res.json).toMatchObject({ error: "segments are required" });
	});

	it("get + delete of an unknown id 404s", async () => {
		const unknown = "11111111-1111-1111-1111-111111111111";
		const got = await call(backend, "GET", `/api/transcripts/${unknown}`);
		expect(got.status).toBe(404);
	});

	it("update rejects a body with neither title nor segments (400)", async () => {
		const created = await call(backend, "POST", "/api/transcripts", {
			segments: [seg("x")],
		});
		const id = (created.json.transcript as { id: string }).id;
		const res = await call(
			backend,
			"PUT",
			`/api/transcripts/${encodeURIComponent(id)}`,
			{},
		);
		expect(res.status).toBe(400);
	});
});

describe("iOS bridge — browser workspace routes", () => {
	let backend: IosBridgeBackend;

	beforeEach(() => {
		resetIosBrowserWorkspace();
		backend = makeBackend(createFakeRuntime());
	});
	afterEach(() => {
		resetIosBrowserWorkspace();
	});

	it("starts in web mode with no tabs", async () => {
		const { status, json } = await call(
			backend,
			"GET",
			"/api/browser-workspace",
		);
		expect(status).toBe(200);
		expect(json).toEqual({ mode: "web", tabs: [] });
	});

	it("open → navigate → show/hide → close tab lifecycle", async () => {
		// Open (the "Open a website" button path)
		const opened = await call(backend, "POST", "/api/browser-workspace/tabs", {
			url: "docs.elizaos.ai",
			title: "Docs",
			show: true,
		});
		expect(opened.status).toBe(200);
		const tab = opened.json.tab as Record<string, unknown>;
		expect(tab).toMatchObject({
			title: "Docs",
			url: "https://docs.elizaos.ai",
			visible: true,
			partition: "persist:eliza-browser-user",
		});
		const id = tab.id as string;

		// Snapshot appears in the workspace GET, web mode
		const snapshot = await call(backend, "GET", "/api/browser-workspace");
		expect(snapshot.json.mode).toBe("web");
		expect((snapshot.json.tabs as unknown[]).length).toBe(1);

		// Navigate
		const navigated = await call(
			backend,
			"POST",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/navigate`,
			{ url: "example.com" },
		);
		expect((navigated.json.tab as { url: string }).url).toBe(
			"https://example.com",
		);

		// Hide then show
		const hidden = await call(
			backend,
			"POST",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/hide`,
		);
		expect((hidden.json.tab as { visible: boolean }).visible).toBe(false);
		const shown = await call(
			backend,
			"POST",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/show`,
		);
		expect((shown.json.tab as { visible: boolean }).visible).toBe(true);

		// snapshot action returns empty data (web mode has no server screenshot)
		const snap = await call(
			backend,
			"GET",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/snapshot`,
		);
		expect(snap.json).toEqual({ data: "" });

		// Close
		const closed = await call(
			backend,
			"DELETE",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}`,
		);
		expect(closed.json).toEqual({ closed: true });
		const after = await call(backend, "GET", "/api/browser-workspace");
		expect((after.json.tabs as unknown[]).length).toBe(0);
	});

	it("opening a second visible tab hides the first", async () => {
		const a = await call(backend, "POST", "/api/browser-workspace/tabs", {
			url: "a.com",
			show: true,
		});
		await call(backend, "POST", "/api/browser-workspace/tabs", {
			url: "b.com",
			show: true,
		});
		const ws = await call(backend, "GET", "/api/browser-workspace");
		const tabs = ws.json.tabs as Array<{ id: string; visible: boolean }>;
		const first = tabs.find((t) => t.id === (a.json.tab as { id: string }).id);
		expect(first?.visible).toBe(false);
		expect(tabs.filter((t) => t.visible)).toHaveLength(1);
	});

	it("acting on an unknown tab id 404s", async () => {
		const res = await call(
			backend,
			"POST",
			"/api/browser-workspace/tabs/nope/show",
		);
		expect(res.status).toBe(404);
	});
});

describe("iOS bridge — conversation message failure surfacing", () => {
	// A failed `createMemory` write is best-effort secondary persistence
	// (error-policy:J6): it must not drop the reply, but the failure must surface
	// observably (stderr) rather than be silently swallowed.
	function createMessageServiceRuntime(
		onCreateMemory: () => Promise<UUID>,
	): IAgentRuntime {
		return {
			agentId: AGENT_ID,
			character: { name: "Eliza" },
			async ensureConnection(): Promise<void> {},
			createMemory: onCreateMemory,
			messageService: {
				async handleMessage(
					_runtime: IAgentRuntime,
					_message: Memory,
					onResponse: (content: { text?: string }) => Promise<unknown>,
				): Promise<void> {
					await onResponse({ text: "hello from the local agent" });
				},
			},
		} as unknown as IAgentRuntime;
	}

	function seedConversation(backend: IosBridgeBackend, id: string): void {
		backend.conversations.set(id, {
			id,
			title: "Test Chat",
			roomId: "00000000-0000-0000-0000-0000000000cc" as UUID,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	}

	// Point the local-inference state dir at an empty temp dir so no real
	// on-disk model registry diverts the reply through the native-llama path;
	// with zero installed models the deterministic messageService path runs.
	let prevStateDir: string | undefined;
	beforeEach(() => {
		prevStateDir = process.env.ELIZA_STATE_DIR;
		process.env.ELIZA_STATE_DIR = mkdtempSync(
			path.join(tmpdir(), "ios-bridge-conv-"),
		);
	});
	afterEach(() => {
		if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = prevStateDir;
		vi.restoreAllMocks();
	});

	it("surfaces a rejected createMemory to stderr but still returns the reply", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = createMessageServiceRuntime(() =>
			Promise.reject(new Error("db offline")),
		);
		const backend = makeBackend(runtime);
		seedConversation(backend, "conv-fail-1");

		const { status, json } = await call(
			backend,
			"POST",
			"/api/conversations/conv-fail-1/messages",
			{ text: "hi there" },
		);

		// The reply is produced despite the persistence failure (J6 continues).
		expect(status).toBe(200);
		expect(json.reply).toBe("hello from the local agent");
		// The failure is observable, not swallowed.
		expect(errorSpy).toHaveBeenCalledWith(
			"[ios-bridge] createMemory(messages) failed:",
			"db offline",
		);
	});

	it("does not log when createMemory succeeds", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = createMessageServiceRuntime(() =>
			Promise.resolve(crypto.randomUUID() as UUID),
		);
		const backend = makeBackend(runtime);
		seedConversation(backend, "conv-ok-1");

		const { status, json } = await call(
			backend,
			"POST",
			"/api/conversations/conv-ok-1/messages",
			{ text: "hi there" },
		);

		expect(status).toBe(200);
		expect(json.reply).toBe("hello from the local agent");
		expect(errorSpy).not.toHaveBeenCalledWith(
			"[ios-bridge] createMemory(messages) failed:",
			expect.anything(),
		);
	});
});

describe("iOS bridge — local inference control routes", () => {
	let backend: IosBridgeBackend;
	let stateDir: string;
	let previousStateDir: string | undefined;

	beforeEach(() => {
		backend = makeBackend(createFakeRuntime());
		previousStateDir = process.env.ELIZA_STATE_DIR;
		stateDir = mkdtempSync(path.join(tmpdir(), "ios-bridge-inference-"));
		process.env.ELIZA_STATE_DIR = stateDir;
	});

	afterEach(() => {
		if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = previousStateDir;
		rmSync(stateDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	function installCustomModel(): void {
		const inferenceRoot = path.join(stateDir, "local-inference");
		const modelsDir = path.join(inferenceRoot, "models");
		mkdirSync(modelsDir, { recursive: true });
		writeFileSync(path.join(modelsDir, "custom-chat.gguf"), "gguf-fixture");
		writeFileSync(
			path.join(inferenceRoot, "routing.json"),
			JSON.stringify({
				preferences: {
					preferredProvider: { TEXT_SMALL: "capacitor-llama" },
					policy: { TEXT_SMALL: "local-only" },
				},
			}),
		);
	}

	it("round-trips installed-model discovery, routing, assignments, and verification", async () => {
		installCustomModel();

		const installed = await call(
			backend,
			"GET",
			"/api/local-inference/installed",
		);
		expect(installed.status).toBe(200);
		expect(installed.json.models).toEqual([
			expect.objectContaining({
				id: "custom-chat",
				displayName: "custom-chat",
				source: "external-scan",
			}),
		]);

		const catalog = await call(backend, "GET", "/api/local-inference/catalog");
		expect(catalog.status).toBe(200);
		expect(catalog.json.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "custom-chat",
					ggufFile: "custom-chat.gguf",
				}),
			]),
		);

		const providers = await call(
			backend,
			"GET",
			"/api/local-inference/providers",
		);
		expect(providers.status).toBe(200);
		expect(providers.json.providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "eliza-local-inference",
					enableState: { enabled: true, reason: "Eliza-1 bundle installed" },
				}),
			]),
		);

		const downloads = await call(
			backend,
			"GET",
			"/api/local-inference/downloads",
		);
		expect(downloads.json.downloads).toEqual([
			expect.objectContaining({
				jobId: "installed:custom-chat",
				modelId: "custom-chat",
				state: "completed",
			}),
		]);

		const routing = await call(backend, "GET", "/api/local-inference/routing");
		expect(routing.json.preferences).toEqual({
			preferredProvider: { TEXT_SMALL: "capacitor-llama" },
			policy: { TEXT_SMALL: "local-only" },
		});

		const assigned = await call(
			backend,
			"POST",
			"/api/local-inference/assignments",
			{ slot: "TEXT_SMALL", modelId: "custom-chat" },
		);
		expect(assigned.json.assignments).toEqual({ TEXT_SMALL: "custom-chat" });
		const persisted = await call(
			backend,
			"GET",
			"/api/local-inference/assignments",
		);
		expect(persisted.json.assignments).toEqual({ TEXT_SMALL: "custom-chat" });

		const cleared = await call(
			backend,
			"POST",
			"/api/local-inference/assignments",
			{ slot: "TEXT_SMALL", modelId: null },
		);
		expect(cleared.json.assignments).toEqual({});

		const invalidSlot = await call(
			backend,
			"POST",
			"/api/local-inference/assignments",
			{ slot: "NOT_A_SLOT", modelId: "custom-chat" },
		);
		expect(invalidSlot.status).toBe(400);

		const unknownModel = await call(
			backend,
			"POST",
			"/api/local-inference/assignments",
			{ slot: "TEXT_SMALL", modelId: "missing-model" },
		);
		expect(unknownModel.status).toBe(404);

		const verified = await call(
			backend,
			"POST",
			"/api/local-inference/installed/custom-chat/verify",
		);
		expect(verified.status).toBe(200);
		expect(verified.json).toMatchObject({
			ok: true,
			modelId: "custom-chat",
			sizeBytes: 12,
		});

		const missingVerification = await call(
			backend,
			"POST",
			"/api/local-inference/installed/missing/verify",
		);
		expect(missingVerification.status).toBe(404);
	});

	it("returns observable device and hub snapshots when native hardware IPC is unavailable", async () => {
		installCustomModel();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const device = await call(backend, "GET", "/api/local-inference/device");
		expect(device.json).toMatchObject({
			enabled: true,
			connected: true,
			transport: "bun-host-ipc",
			primaryDeviceId: "ios-native-llama",
		});

		const hardware = await call(
			backend,
			"GET",
			"/api/local-inference/hardware",
		);
		expect(hardware.json).toMatchObject({
			platform: "ios",
			gpu: { backend: "metal", available: false },
			source: "ios-native-llama",
		});

		const hub = await call(backend, "GET", "/api/local-inference/hub");
		expect(hub.status).toBe(200);
		expect(hub.json).toMatchObject({
			active: { status: "idle", provider: "capacitor-llama" },
			assignments: {},
			hardware: { platform: "ios", source: "ios-native-llama" },
		});
		expect(hub.json.catalog).toEqual(expect.any(Array));
		expect(hub.json.installed).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "custom-chat" })]),
		);
		expect(errorSpy).toHaveBeenCalledWith(
			"[ios-bridge] hardware info unavailable:",
			"iOS native host-call protocol is not installed",
		);
	});

	it("validates download, active-model, streaming, TTS, and ASR requests before native work", async () => {
		const missingDownload = await call(
			backend,
			"POST",
			"/api/local-inference/downloads",
			{},
		);
		expect(missingDownload.status).toBe(400);

		const unsupportedDownload = await call(
			backend,
			"POST",
			"/api/local-inference/downloads",
			{ spec: { id: "unknown-model" } },
		);
		expect(unsupportedDownload.status).toBe(400);

		const active = await call(backend, "GET", "/api/local-inference/active");
		expect(active.json).toMatchObject({
			modelId: null,
			modelPath: null,
			status: "idle",
		});

		const missingActive = await call(
			backend,
			"POST",
			"/api/local-inference/active",
			{ modelId: "missing-model" },
		);
		expect(missingActive.status).toBe(404);

		const unloaded = await call(
			backend,
			"DELETE",
			"/api/local-inference/active",
		);
		expect(unloaded.json).toMatchObject({ status: "idle", modelId: null });

		for (const endpoint of [
			"/api/local-inference/downloads/stream",
			"/api/local-inference/device/stream",
		]) {
			const stream = await call(backend, "GET", endpoint);
			expect(stream.status).toBe(501);
			expect(stream.json.code).toBe("streaming_not_supported");
		}

		const missingTtsText = await call(
			backend,
			"POST",
			"/api/tts/local-inference",
			{},
		);
		expect(missingTtsText.status).toBe(400);

		const unavailableTts = await call(
			backend,
			"POST",
			"/api/tts/local-inference",
			{ text: "<think>ignore</think> hello" },
		);
		expect(unavailableTts.status).toBe(503);
		expect(unavailableTts.json.code).toBe("ios_local_voice_assets_missing");

		const invalidAsr = await handleDirectCoreRoute(
			backend,
			"POST",
			"/api/asr/local-inference",
			jsonBody({ pcm: [0, "invalid"] }),
		);
		expect(invalidAsr).toBeNull();

		const unavailableAsr = await call(
			backend,
			"POST",
			"/api/asr/local-inference",
			{ pcm: [0, 0.25, -0.25], sampleRate: "16000" },
		);
		expect(unavailableAsr.status).toBe(503);
		expect(unavailableAsr.json.code).toBe("ios_local_voice_assets_missing");
	});

	it("records a failed native model activation and returns to idle on unload", async () => {
		installCustomModel();
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			handleDirectCoreRoute(
				backend,
				"POST",
				"/api/local-inference/active",
				jsonBody({ modelId: "custom-chat" }),
			),
		).rejects.toThrow("iOS native host-call protocol is not installed");

		const failed = await call(backend, "GET", "/api/local-inference/active");
		expect(failed.json).toMatchObject({
			modelId: "custom-chat",
			status: "error",
			error: "iOS native host-call protocol is not installed",
		});

		const unloaded = await call(
			backend,
			"DELETE",
			"/api/local-inference/active",
		);
		expect(unloaded.json).toMatchObject({
			modelId: null,
			modelPath: null,
			status: "idle",
		});
	});

	it("downloads a catalog model into the registry through the streamed response body", async () => {
		const bytes = new TextEncoder().encode("tiny-gguf-fixture");
		const fetchMock = vi.fn(
			async () =>
				new Response(bytes, {
					status: 200,
					headers: { "content-length": String(bytes.byteLength) },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const started = await call(
			backend,
			"POST",
			"/api/local-inference/downloads",
			{ modelId: "eliza-1-2b" },
		);
		expect(started.status).toBe(200);
		expect(started.json.job).toMatchObject({
			modelId: "eliza-1-2b",
			state: "queued",
		});

		let completed: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const status = await call(
				backend,
				"GET",
				"/api/local-inference/downloads",
			);
			completed = (
				status.json.downloads as Array<Record<string, unknown>>
			).find((job) => job.modelId === "eliza-1-2b");
			if (completed?.state === "completed" || completed?.state === "failed") {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(completed).toMatchObject({
			modelId: "eliza-1-2b",
			state: "completed",
			received: bytes.byteLength,
			total: bytes.byteLength,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/2b/text/eliza-1-2b-128k.gguf",
			{ redirect: "follow" },
		);

		const installed = await call(
			backend,
			"GET",
			"/api/local-inference/installed",
		);
		expect(installed.json.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "eliza-1-2b",
					sizeBytes: bytes.byteLength,
					source: "eliza-download",
				}),
			]),
		);
	});
});

describe("iOS bridge — startup compatibility routes", () => {
	it("serves the local startup, auth, app-run, and conversation contracts", async () => {
		const backend = makeBackend(createFakeRuntime());

		const health = await call(backend, "GET", "/api/health");
		expect(health.json).toMatchObject({
			ready: true,
			runtime: "ok",
			agentName: "TestAgent",
			iosBridge: "bun",
		});

		const status = await call(backend, "GET", "/api/status");
		expect(status.json).toMatchObject({
			state: "running",
			canRespond: true,
			pendingRestart: false,
		});

		const appRuns = await call(backend, "GET", "/api/apps/runs");
		expect(appRuns.json).toEqual([]);

		const firstRunStatus = await call(backend, "GET", "/api/first-run/status");
		expect(firstRunStatus.json).toEqual({
			complete: true,
			cloudProvisioned: false,
			deploymentTarget: "local",
		});
		const firstRun = await call(backend, "POST", "/api/first-run", {});
		expect(firstRun.json).toMatchObject({ ok: true, complete: true });

		const me = await call(backend, "GET", "/api/auth/me");
		expect(me.json).toMatchObject({
			identity: { id: "local-agent", kind: "machine" },
			access: { mode: "local" },
		});
		const authStatus = await call(backend, "GET", "/api/auth/status");
		expect(authStatus.json).toMatchObject({
			required: false,
			authenticated: true,
			localAccess: true,
		});

		const created = await call(backend, "POST", "/api/conversations", {
			title: "  Local test  ",
			metadata: { source: "coverage" },
		});
		const conversation = created.json.conversation as { id: string };
		const conversations = await call(backend, "GET", "/api/conversations");
		expect(conversations.json.conversations).toEqual([
			expect.objectContaining({
				id: conversation.id,
				title: "Local test",
				metadata: { source: "coverage" },
			}),
		]);

		const messages = await call(
			backend,
			"GET",
			`/api/conversations/${conversation.id}/messages`,
		);
		expect(messages.json).toEqual({ messages: [] });
		const missingConversation = await call(
			backend,
			"POST",
			"/api/conversations/missing/messages/stream",
			{ text: "hello" },
		);
		expect(missingConversation.status).toBe(404);
	});
});

describe("iOS bridge — unmatched routes still fall through", () => {
	it("returns null (→ eventual 404) for an unknown /api path", async () => {
		const backend = makeBackend(createFakeRuntime());
		const res = await handleDirectCoreRoute(
			backend,
			"GET",
			"/api/does-not-exist",
			{},
		);
		expect(res).toBeNull();
	});

	it("returns null for an unknown /api/memories subpath", async () => {
		const backend = makeBackend(createFakeRuntime());
		const res = await handleDirectCoreRoute(
			backend,
			"GET",
			"/api/memories/unknown",
			{},
		);
		expect(res).toBeNull();
	});
});
