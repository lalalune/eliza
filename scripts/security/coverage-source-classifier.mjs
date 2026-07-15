#!/usr/bin/env node
/** Emits changed modules that retain runtime code after Node strips TypeScript-only syntax. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bunTypeScriptTranspiler = globalThis.Bun
  ? new globalThis.Bun.Transpiler({ loader: "ts" })
  : undefined;

function eraseTypeScriptSyntax(source) {
  if (typeof nodeModule.stripTypeScriptTypes === "function") {
    return nodeModule.stripTypeScriptTypes(source, {
      mode: "transform",
      sourceMap: false,
    });
  }
  if (bunTypeScriptTranspiler) {
    return bunTypeScriptTranspiler.transformSync(source);
  }
  throw new Error("TypeScript syntax erasure is unavailable in this runtime");
}

function runtimeSource(source) {
  return eraseTypeScriptSyntax(source).trim();
}

// Node's strip mode blanks type-only syntax to whitespace while preserving
// every comment, which keeps comment anchors invariant to type-annotation
// edits. Bun ships no comment-preserving type stripper (Bun.Transpiler drops
// comments), so under Bun the raw source is the anchor basis: a type-length
// edit can then shift a comment anchor and conservatively retain the module,
// which only ever widens coverage enforcement. The gate itself runs on Node.
function stripTypeScriptSyntaxPreservingComments(source) {
  if (typeof nodeModule.stripTypeScriptTypes === "function") {
    return nodeModule.stripTypeScriptTypes(source, {
      mode: "strip",
      sourceMap: false,
    });
  }
  return source;
}

const SEMANTIC_COMMENT_DIRECTIVE =
  /(?:@vite-ignore\b|webpack(?:ChunkName|Mode|Prefetch|Preload|Ignore|FetchPriority|Exports|Include|Exclude)\s*:|(?:c8|istanbul|v8)\s+ignore\b|node:coverage\s+(?:ignore|disable|enable)\b|@ts-(?:check|nocheck|ignore|expect-error)\b|@jsx(?:Frag|ImportSource|Runtime)?\b|\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b|[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE)__\b|[#@]\s*source(?:Mapping)?URL\s*=)/i;

/**
 * Captures comments that alter compiler, bundler, optimizer, or coverage-tool
 * behavior. Ordinary prose is absent so documentation-only edits remain
 * runtime-equivalent; anchors retain directive placement relative to code.
 */
function semanticCommentRecords(source) {
  const stripped = stripTypeScriptSyntaxPreservingComments(source);
  const commentLike = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  const records = [];
  let cursor = 0;
  let anchor = 0;
  for (const match of stripped.matchAll(commentLike)) {
    const index = match.index ?? 0;
    anchor += stripped.slice(cursor, index).replace(/\s/g, "").length;
    if (SEMANTIC_COMMENT_DIRECTIVE.test(match[0])) {
      records.push([anchor, match[0]]);
    }
    cursor = index + match[0].length;
  }
  return records;
}

/** Stable fingerprint of syntax erased by Node's position-preserving strip. */
function erasedTypeSignature(source) {
  const stripped = stripTypeScriptSyntaxPreservingComments(source);
  let signature = "";
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== stripped[index] && !/\s/.test(source[index])) {
      signature += source[index];
    }
  }
  return signature;
}

/** Any transformed `@` fail-widens an actual erased-type change. */
function transformedRuntimeContainsAtSign(source) {
  return runtimeSource(source).includes("@");
}

/** V8 emits no line records for a module made entirely of re-export facades. */
function isPureReExportFacade(source) {
  const reExport =
    /export\s+(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?|\{[^}]*\})\s+from\s+["'][^"']+["']\s*;?/gs;
  return source.trim().length > 0 && source.replace(reExport, "").trim() === "";
}

/** Returns true only when type erasure leaves coverable runtime statements. */
export function sourceRetainsRuntimeCode(source) {
  const emittedSource = runtimeSource(source);
  return emittedSource.length > 0 && !isPureReExportFacade(emittedSource);
}

/** Returns true unless emitted JavaScript and semantic compile inputs match. */
export function sourceChangesRuntimeCode(baseSource, headSource) {
  const emittedHead = runtimeSource(headSource);
  if (emittedHead.length === 0 || isPureReExportFacade(emittedHead)) {
    return false;
  }
  if (runtimeSource(baseSource) !== emittedHead) return true;
  if (
    JSON.stringify(semanticCommentRecords(baseSource)) !==
    JSON.stringify(semanticCommentRecords(headSource))
  ) {
    return true;
  }
  // Type annotations can alter emitted decorator metadata under repository
  // tsconfigs even when Node's transform output is otherwise identical.
  return (
    erasedTypeSignature(baseSource) !== erasedTypeSignature(headSource) &&
    (transformedRuntimeContainsAtSign(baseSource) ||
      transformedRuntimeContainsAtSign(headSource))
  );
}

/** Classifier failures retain the file as a coverage target. */
export function pathRetainsRuntimeCode(
  path,
  warn = (message) => process.stderr.write(message),
) {
  try {
    const source = readFileSync(path, "utf8");
    return sourceRetainsRuntimeCode(source);
  } catch (error) {
    // A classifier failure must widen enforcement, never hide the source.
    warn(
      `[coverage-source-classifier] treating unclassifiable module as executable: ${path} (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return true;
  }
}

/** Writes coverable paths and explains independently proven exclusions. */
export function classifyPaths(
  paths,
  writeOutput = (message) => process.stdout.write(message),
  writeError = (message) => process.stderr.write(message),
  { readBaseSource } = {},
) {
  for (const path of paths) {
    if (!pathRetainsRuntimeCode(path, writeError)) {
      writeError(
        `[coverage-source-classifier] excluding module without coverable runtime statements: ${path}\n`,
      );
      continue;
    }

    if (readBaseSource) {
      try {
        const baseSource = readBaseSource(path);
        if (baseSource !== undefined) {
          const headSource = readFileSync(path, "utf8");
          if (!sourceChangesRuntimeCode(baseSource, headSource)) {
            writeError(
              `[coverage-source-classifier] excluding runtime-equivalent source change: ${path}\n`,
            );
            continue;
          }
        }
      } catch (error) {
        // A failed comparison must retain the module just like a failed parse.
        writeError(
          `[coverage-source-classifier] treating unclassifiable source change as executable: ${path} (${error instanceof Error ? error.message : String(error)})\n`,
        );
      }
    }

    writeOutput(`${path}\n`);
  }
}

function parseRevisions(args) {
  if (args.length === 0) return {};
  const revisions = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== "--base" && flag !== "--head")) {
      throw new Error(
        "usage: coverage-source-classifier.mjs [--base <git-revision> --head <git-revision>]",
      );
    }
    revisions[flag.slice(2)] = value;
  }
  if (revisions.head && !revisions.base) {
    throw new Error("--head requires --base");
  }
  return revisions;
}

function readSourceAtRevision(revision, sourcePath) {
  try {
    return execFileSync(
      "git",
      ["cat-file", "blob", `${revision}:${sourcePath}`],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return undefined;
  }
}

/**
 * Finds same-directory renames and extracted copies between the revisions.
 * Moving across directories stays enforced because it can change relative
 * import resolution.
 */
function readSameDirectoryRelocations(baseRef, headRef) {
  if (!headRef) return new Map();
  try {
    const output = execFileSync(
      "git",
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies-harder",
        "--diff-filter=CR",
        baseRef,
        headRef,
      ],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const fields = output.split("\0");
    const relocations = new Map();
    for (let index = 0; index < fields.length; ) {
      const status = fields[index++];
      if (!status) continue;
      const sourcePath = fields[index++];
      const destinationPath = fields[index++];
      if (
        /^[CR]\d+$/.test(status) &&
        sourcePath &&
        destinationPath &&
        path.dirname(sourcePath) === path.dirname(destinationPath)
      ) {
        relocations.set(destinationPath, sourcePath);
      }
    }
    return relocations;
  } catch {
    // Rename discovery only narrows proven no-op moves. Failure retains the
    // destination as a new executable file, which is the safe default.
    return new Map();
  }
}

function createBaseSourceReader(baseRef, headRef) {
  const relocationSources = readSameDirectoryRelocations(baseRef, headRef);
  return (currentPath) => {
    const samePathSource = readSourceAtRevision(baseRef, currentPath);
    if (samePathSource !== undefined) return samePathSource;

    const relocatedFrom = relocationSources.get(currentPath);
    if (!relocatedFrom) return undefined;
    const relocatedSource = readSourceAtRevision(baseRef, relocatedFrom);
    if (relocatedSource === undefined) return undefined;

    // Any content change keeps the renamed path enforced; only a byte-identical
    // move can borrow the old path as its comparison baseline.
    return readFileSync(currentPath, "utf8") === relocatedSource
      ? relocatedSource
      : undefined;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { base: baseRef, head: headRef } = parseRevisions(
    process.argv.slice(2),
  );
  classifyPaths(
    readFileSync(0, "utf8").split("\n").filter(Boolean),
    undefined,
    undefined,
    {
      readBaseSource: baseRef
        ? createBaseSourceReader(baseRef, headRef)
        : undefined,
    },
  );
}
