/**
 * Fail-closed live-model proof runner for post-sign-in goal discovery.
 *
 * It rejects proxy mode and missing credentials, runs exactly one scenario,
 * then independently validates the report, viewer, native rows, and raw model
 * trajectories before writing a machine-readable proof verdict.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const LIVE_ONBOARDING_SCENARIO_ID = "live-post-sign-in-activation-goal";

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");
const LIVE_PROVIDER_KEYS = [
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
];
const LIVE_PROOF_PROVIDER_ENV = "LIVE_ONBOARDING_LLM_PROVIDER";
const LIVE_PROOF_PROVIDER_KEYS = {
  groq: ["GROQ_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};
const PROXY_FLAGS = ["SCENARIO_USE_LLM_PROXY", "ELIZA_SCENARIO_USE_LLM_PROXY"];
const CLI_PROVIDERS = new Set(["claude", "claude-sdk", "codex", "codex-sdk"]);
const PROBLEM_MARKER = "shipping the iOS version of my app";
const EVALUATOR_MARKER =
  "Decide whether this turn reveals the owner's PRIMARY goal";

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function envExplicitlyFalse(value) {
  return ["0", "false", "no", "off"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function assertLiveProofPreconditions(env = process.env) {
  const enabledProxy = PROXY_FLAGS.find((key) => envFlag(env[key]));
  if (enabledProxy) {
    throw new Error(
      `${enabledProxy} enables the deterministic LLM proxy; this proof requires a live provider`,
    );
  }
  if (envFlag(env.ELIZA_DISABLE_TRAJECTORY_LOGGING)) {
    throw new Error(
      "ELIZA_DISABLE_TRAJECTORY_LOGGING disables required raw trajectory evidence",
    );
  }
  if (envExplicitlyFalse(env.ELIZA_TRAJECTORY_LOGGING)) {
    throw new Error(
      "ELIZA_TRAJECTORY_LOGGING explicitly disables required raw trajectory evidence",
    );
  }

  const credentialKeys = LIVE_PROVIDER_KEYS.filter(
    (key) => typeof env[key] === "string" && env[key].trim().length > 0,
  );
  const cliProvider = String(env.ELIZA_CHAT_VIA_CLI ?? "")
    .trim()
    .toLowerCase();
  if (credentialKeys.length === 0 && !CLI_PROVIDERS.has(cliProvider)) {
    throw new Error(
      `No live model provider is configured. Set one of ${LIVE_PROVIDER_KEYS.join(", ")} or ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex|codex-sdk`,
    );
  }
  const requestedProvider = String(env[LIVE_PROOF_PROVIDER_ENV] ?? "")
    .trim()
    .toLowerCase();
  if (
    requestedProvider &&
    !Object.hasOwn(LIVE_PROOF_PROVIDER_KEYS, requestedProvider) &&
    requestedProvider !== "cli"
  ) {
    throw new Error(
      `${LIVE_PROOF_PROVIDER_ENV} must be one of ${Object.keys(LIVE_PROOF_PROVIDER_KEYS).join(", ")}, cli`,
    );
  }
  if (requestedProvider === "cli" && !CLI_PROVIDERS.has(cliProvider)) {
    throw new Error(
      `${LIVE_PROOF_PROVIDER_ENV}=cli requires ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex|codex-sdk`,
    );
  }
  if (requestedProvider && requestedProvider !== "cli") {
    const requiredKeys = LIVE_PROOF_PROVIDER_KEYS[requestedProvider];
    if (!requiredKeys.some((key) => credentialKeys.includes(key))) {
      throw new Error(
        `${LIVE_PROOF_PROVIDER_ENV}=${requestedProvider} requires one of ${requiredKeys.join(", ")}`,
      );
    }
  }
  return {
    credentialKeys,
    cliProvider: CLI_PROVIDERS.has(cliProvider) ? cliProvider : null,
    requestedProvider: requestedProvider || null,
  };
}

export function buildLiveScenarioEnv(
  env = process.env,
  requestedProvider = null,
) {
  const childEnv = {
    ...env,
    SCENARIO_USE_LLM_PROXY: "0",
    ELIZA_SCENARIO_USE_LLM_PROXY: "0",
    SKIP_REASON: "",
  };
  if (!requestedProvider) {
    return childEnv;
  }

  const retainedValues = new Map(
    LIVE_PROVIDER_KEYS.map((key) => [key, childEnv[key]]),
  );
  for (const key of LIVE_PROVIDER_KEYS) {
    childEnv[key] = "";
  }
  childEnv.SMALL_MODEL = "";
  childEnv.LARGE_MODEL = "";

  if (requestedProvider === "cli") {
    return childEnv;
  }
  for (const key of LIVE_PROOF_PROVIDER_KEYS[requestedProvider]) {
    const value = retainedValues.get(key);
    if (value) childEnv[key] = value;
  }

  if (requestedProvider === "openai") {
    childEnv.OPENAI_BASE_URL = "";
    childEnv.OPENAI_SMALL_MODEL = "";
    childEnv.OPENAI_LARGE_MODEL = "";
    childEnv.ELIZA_PROVIDER = "";
  } else if (requestedProvider === "cerebras") {
    const model =
      String(childEnv.CEREBRAS_MODEL ?? "").trim() || "gpt-oss-120b";
    childEnv.OPENAI_BASE_URL = "https://api.cerebras.ai/v1";
    childEnv.OPENAI_SMALL_MODEL = model;
    childEnv.OPENAI_LARGE_MODEL = model;
    childEnv.ELIZA_PROVIDER = "cerebras";
  }
  return childEnv;
}

function collectFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function requireFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${file}`);
  }
}

function nativeRequestBlob(row) {
  return JSON.stringify(row?.request ?? {});
}

function modelCallEvidenceRecord(trajectoryId, stepId, call) {
  return {
    trajectoryId,
    stepId,
    callId: call?.callId,
    timestamp: call?.timestamp,
    model: call?.model,
    modelType: call?.modelType,
    provider: call?.provider,
    systemPrompt: call?.systemPrompt,
    userPrompt: call?.userPrompt,
    prompt: call?.prompt,
    response: call?.response,
    toolCalls: call?.toolCalls,
    finishReason: call?.finishReason,
    reasoning: call?.reasoning,
    purpose: call?.purpose,
    actionType: call?.actionType,
    stepType: call?.stepType,
    promptTokens: call?.promptTokens,
    completionTokens: call?.completionTokens,
    latencyMs: call?.latencyMs,
    runId: call?.runId,
    roomId: call?.roomId,
    messageId: call?.messageId,
    executionTraceId: call?.executionTraceId,
  };
}

export async function exportScenarioModelCallEvidence({
  pgliteDir,
  outputPath,
}) {
  const { PGlite } = await import("@electric-sql/pglite");
  const database = new PGlite(pgliteDir);
  try {
    const result = await database.query(
      "SELECT id, steps_json FROM trajectories WHERE scenario_id = $1 ORDER BY start_time ASC",
      [LIVE_ONBOARDING_SCENARIO_ID],
    );
    const modelCalls = [];
    for (const row of result.rows) {
      const steps =
        typeof row.steps_json === "string"
          ? JSON.parse(row.steps_json)
          : row.steps_json;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        if (!Array.isArray(step?.llmCalls)) continue;
        for (const call of step.llmCalls) {
          modelCalls.push(modelCallEvidenceRecord(row.id, step?.stepId, call));
        }
      }
    }
    writeFileSync(
      outputPath,
      `${JSON.stringify(
        {
          schema: "eliza.scenario-model-call-evidence.v1",
          scenarioId: LIVE_ONBOARDING_SCENARIO_ID,
          modelCalls,
        },
        null,
        2,
      )}\n`,
    );
    return modelCalls;
  } finally {
    await database.close();
  }
}

export function validateLiveProofEvidence(paths) {
  requireFile(paths.report, "aggregate report");
  requireFile(path.join(paths.runDir, "viewer", "index.html"), "run viewer");
  requireFile(path.join(paths.runDir, "viewer", "data.js"), "run viewer data");
  requireFile(paths.nativeJsonl, "native JSONL");
  requireFile(paths.modelCalls, "trajectory-service model-call evidence");

  const report = readJson(paths.report);
  if (
    report.providerName === "deterministic-llm-proxy" ||
    typeof report.providerName !== "string" ||
    report.providerName.length === 0
  ) {
    throw new Error(
      `report provider must be live, saw ${JSON.stringify(report.providerName)}`,
    );
  }
  if (
    report.totalCount !== 1 ||
    report.passedCount !== 1 ||
    report.failedCount !== 0 ||
    report.skippedCount !== 0
  ) {
    throw new Error(
      `expected one passed, zero-failure, zero-skip scenario; saw total=${report.totalCount} passed=${report.passedCount} failed=${report.failedCount} skipped=${report.skippedCount}`,
    );
  }
  const scenario = Array.isArray(report.scenarios)
    ? report.scenarios.find(
        (candidate) => candidate?.id === LIVE_ONBOARDING_SCENARIO_ID,
      )
    : undefined;
  if (scenario?.status !== "passed") {
    throw new Error(
      `${LIVE_ONBOARDING_SCENARIO_ID} did not pass: ${JSON.stringify(scenario ?? report.scenarios)}`,
    );
  }
  const skippedCheck = scenario.finalChecks?.find(
    (check) => check?.status !== "passed",
  );
  if (skippedCheck) {
    throw new Error(
      `scenario final check did not pass: ${JSON.stringify(skippedCheck)}`,
    );
  }

  const trajectoryFiles = collectFiles(
    path.join(paths.runDir, "trajectories"),
  ).filter((file) => file.endsWith(".json"));
  if (trajectoryFiles.length === 0) {
    throw new Error("no raw trajectory JSON files were recorded");
  }
  const trajectories = trajectoryFiles.map((file) => ({
    file,
    payload: readJson(file),
  }));
  const trajectoryBlob = trajectories
    .map(({ payload }) => JSON.stringify(payload))
    .join("\n");
  if (!trajectoryBlob.includes(PROBLEM_MARKER)) {
    throw new Error(
      "raw trajectories do not contain the owner's actual problem statement",
    );
  }

  const modelCallEvidence = readJson(paths.modelCalls);
  const modelCalls = Array.isArray(modelCallEvidence?.modelCalls)
    ? modelCallEvidence.modelCalls
    : [];
  const evaluatorCalls = modelCalls.filter((call) => {
    const input = [call?.systemPrompt, call?.userPrompt, call?.prompt]
      .filter((part) => typeof part === "string")
      .join("\n");
    return input.includes(PROBLEM_MARKER) && input.includes(EVALUATOR_MARKER);
  });
  if (evaluatorCalls.length === 0) {
    throw new Error(
      "trajectory-service evidence does not prove the FTU evaluator saw the owner's problem",
    );
  }
  if (
    !evaluatorCalls.some((call) =>
      /\b(goalFound|primaryGoal|iOS|app|release|shipping)\b/i.test(
        String(call?.response ?? ""),
      ),
    )
  ) {
    throw new Error(
      "trajectory-service FTU evaluator calls contain no inspectable goal extraction output",
    );
  }

  const nativeRows = readFileSync(paths.nativeJsonl, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (nativeRows.length === 0) {
    throw new Error("native JSONL contains no model-boundary rows");
  }
  const wrongScenarioRow = nativeRows.find(
    (row) => row?.scenarioId !== LIVE_ONBOARDING_SCENARIO_ID,
  );
  if (wrongScenarioRow) {
    throw new Error(
      `native row has the wrong scenario id: ${JSON.stringify(wrongScenarioRow?.scenarioId)}`,
    );
  }
  const deterministicRow = nativeRows.find((row) =>
    /deterministic|llm-proxy/i.test(
      `${String(row?.provider ?? "")} ${String(row?.model ?? "")}`,
    ),
  );
  if (deterministicRow) {
    throw new Error(
      `native rows contain a deterministic provider/model: ${JSON.stringify({
        provider: deterministicRow.provider,
        model: deterministicRow.model,
      })}`,
    );
  }
  const problemRows = nativeRows.filter((row) =>
    nativeRequestBlob(row).includes(PROBLEM_MARKER),
  );
  if (problemRows.length === 0) {
    throw new Error(
      "native model-boundary rows do not contain the owner's problem input",
    );
  }

  return {
    schema: "eliza.live-onboarding-activation-proof.v1",
    passed: true,
    validatedAt: new Date().toISOString(),
    scenarioId: LIVE_ONBOARDING_SCENARIO_ID,
    providerName: report.providerName,
    scenarioStatus: scenario.status,
    finalChecks: scenario.finalChecks?.length ?? 0,
    trajectoryFiles: trajectoryFiles.map((file) =>
      path.relative(paths.outputDir, file),
    ),
    nativeRows: nativeRows.length,
    problemBoundaryRows: problemRows.length,
    evaluatorBoundaryRows: evaluatorCalls.length,
    artifacts: {
      report: path.relative(paths.outputDir, paths.report),
      viewer: path.relative(
        paths.outputDir,
        path.join(paths.runDir, "viewer", "index.html"),
      ),
      nativeJsonl: path.relative(paths.outputDir, paths.nativeJsonl),
      modelCalls: path.relative(paths.outputDir, paths.modelCalls),
    },
  };
}

function parseOutputDir(argv) {
  const outIndex = argv.indexOf("--out");
  if (outIndex >= 0) {
    const value = argv[outIndex + 1];
    if (!value) {
      throw new Error("--out requires a directory");
    }
    return path.resolve(process.cwd(), value);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    repoRoot,
    "reports",
    "scenarios",
    "live-onboarding-activation",
    stamp,
  );
}

async function runScenarioProcess(args, stdoutLog, stderrLog, childEnv) {
  writeFileSync(stdoutLog, "");
  writeFileSync(stderrLog, "");
  const child = spawn("bun", args, {
    cwd: packageDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    writeFileSync(stdoutLog, chunk, { flag: "a" });
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    writeFileSync(stderrLog, chunk, { flag: "a" });
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`scenario runner terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const providerInputs = assertLiveProofPreconditions();
  const outputDir = parseOutputDir(argv);
  const report = path.join(outputDir, "report.json");
  const reportDir = path.join(outputDir, "report");
  const runDir = path.join(outputDir, "run");
  const nativeJsonl = path.join(outputDir, "native.jsonl");
  const stdoutLog = path.join(outputDir, "runner.stdout.log");
  const stderrLog = path.join(outputDir, "runner.stderr.log");
  const validationPath = path.join(outputDir, "validation.json");
  const pgliteDir = path.join(outputDir, "pglite");
  const modelCalls = path.join(outputDir, "model-calls.json");
  const runId = `onboarding-activation-${Date.now()}`;
  mkdirSync(outputDir, { recursive: true });

  process.stdout.write(
    `[live-onboarding-proof] provider inputs: ${
      providerInputs.credentialKeys.join(", ") ||
      `ELIZA_CHAT_VIA_CLI=${providerInputs.cliProvider}`
    }\n[live-onboarding-proof] selected provider: ${
      providerInputs.requestedProvider ?? "runtime priority"
    }\n[live-onboarding-proof] evidence: ${outputDir}\n`,
  );

  const childEnv = buildLiveScenarioEnv(
    process.env,
    providerInputs.requestedProvider,
  );
  childEnv.SCENARIO_PGLITE_DIR = pgliteDir;
  childEnv.SCENARIO_SAVE_TRAJECTORIES = "1";
  const code = await runScenarioProcess(
    [
      "--conditions",
      "eliza-source",
      "--tsconfig-override",
      "../../tsconfig.json",
      "src/cli.ts",
      "run",
      "test/scenarios",
      "--scenario",
      LIVE_ONBOARDING_SCENARIO_ID,
      "--lane",
      "live-only",
      "--runId",
      runId,
      "--report",
      report,
      "--report-dir",
      reportDir,
      "--run-dir",
      runDir,
      "--export-native",
      nativeJsonl,
    ],
    stdoutLog,
    stderrLog,
    childEnv,
  );
  await exportScenarioModelCallEvidence({
    pgliteDir,
    outputPath: modelCalls,
  });
  if (code !== 0) {
    throw new Error(
      `live onboarding scenario failed with exit code ${code}; inspect ${stdoutLog} and ${stderrLog}`,
    );
  }

  const verdict = validateLiveProofEvidence({
    outputDir,
    report,
    runDir,
    nativeJsonl,
    modelCalls,
  });
  writeFileSync(validationPath, `${JSON.stringify(verdict, null, 2)}\n`);
  process.stdout.write(
    `[live-onboarding-proof] PASS provider=${verdict.providerName} nativeRows=${verdict.nativeRows} trajectories=${verdict.trajectoryFiles.length}\n[live-onboarding-proof] validation: ${validationPath}\n`,
  );
  return verdict;
}

const invokedAsScript =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(
      `[live-onboarding-proof] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
