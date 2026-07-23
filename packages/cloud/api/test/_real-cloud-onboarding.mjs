/**
 * Proves the real Cloud onboarding path against a deployed API.
 *
 * The script mints a SIWE key, creates the same always-on agent requested by
 * the app, probes shared chat during provisioning, waits for the dedicated
 * endpoint, and deletes the agent. Every required outcome is fail-closed so
 * exploratory logs cannot be mistaken for a passing end-to-end run.
 */

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const API = process.env.CLOUD_API || "https://api.elizacloud.ai";
const CREATE_SUCCESS_STATUSES = new Set([200, 201, 202]);
const log = (...args) =>
  console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(method, route, { token, body, base } = {}) {
  const response = await fetch((base || API) + route, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // error-policy:J3 A non-JSON upstream body remains explicitly inspectable.
    data = text;
  }
  return { status: response.status, data };
}

function isElapsedSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function errorReport(error) {
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.map((cause) =>
        cause instanceof Error ? cause.message : String(cause),
      ),
    ].join("\n");
  }
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

export function validateRealCloudOnboardingOutcome(outcome) {
  const failures = [];
  if (
    outcome.nonceStatus !== 200 ||
    typeof outcome.nonceDomain !== "string" ||
    !outcome.nonceDomain ||
    typeof outcome.nonce !== "string" ||
    !outcome.nonce
  ) {
    failures.push(
      `SIWE nonce was not usable (status=${String(outcome.nonceStatus)})`,
    );
  }
  if (
    outcome.verifyStatus !== 200 ||
    typeof outcome.token !== "string" ||
    !outcome.token
  ) {
    failures.push(
      `SIWE verification did not mint an API key (status=${String(outcome.verifyStatus)})`,
    );
  }
  if (
    !CREATE_SUCCESS_STATUSES.has(outcome.createStatus) ||
    typeof outcome.agentId !== "string" ||
    !outcome.agentId
  ) {
    failures.push(
      `agent creation did not return a usable id (status=${String(outcome.createStatus)})`,
    );
  }
  if (!isElapsedSeconds(outcome.firstChatOk)) {
    failures.push("shared chat never returned a model response");
  }
  if (!isElapsedSeconds(outcome.readyAt)) {
    failures.push("dedicated agent readiness timed out");
  }
  if (
    typeof outcome.agentId === "string" &&
    outcome.agentId &&
    (typeof outcome.cleanupStatus !== "number" ||
      outcome.cleanupStatus < 200 ||
      outcome.cleanupStatus >= 300)
  ) {
    failures.push(
      `agent cleanup was not accepted (status=${String(outcome.cleanupStatus)})`,
    );
  }
  if (outcome.cleanupError) {
    failures.push(`agent cleanup threw: ${outcome.cleanupError}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Real Cloud onboarding proof failed:\n- ${failures.join("\n- ")}`,
    );
  }
  return {
    passed: true,
    firstChatSeconds: outcome.firstChatOk,
    dedicatedReadySeconds: outcome.readyAt,
    cleanupStatus: outcome.cleanupStatus,
  };
}

async function acquireNonce() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await requestJson("GET", "/api/auth/siwe/nonce?chainId=1");
    if (
      response.status === 200 &&
      typeof response.data?.domain === "string" &&
      response.data.domain &&
      typeof response.data?.nonce === "string" &&
      response.data.nonce
    ) {
      return response;
    }
    log(
      "nonce retry",
      attempt,
      response.status,
      JSON.stringify(response.data).slice(0, 60),
    );
    await sleep(4000);
  }
  return { status: null, data: null };
}

export async function main() {
  const outcome = {
    nonceStatus: null,
    nonceDomain: null,
    nonce: null,
    verifyStatus: null,
    token: null,
    createStatus: null,
    agentId: null,
    firstChatOk: null,
    readyAt: null,
    cleanupStatus: null,
    cleanupError: null,
  };
  let primaryError = null;

  try {
    const nonceResponse = await acquireNonce();
    outcome.nonceStatus = nonceResponse.status;
    outcome.nonceDomain = nonceResponse.data?.domain ?? null;
    outcome.nonce = nonceResponse.data?.nonce ?? null;
    if (outcome.nonceStatus !== 200 || !outcome.nonceDomain || !outcome.nonce) {
      throw new Error("SIWE nonce remained unavailable after five attempts");
    }

    const account = privateKeyToAccount(generatePrivateKey());
    const message = createSiweMessage({
      address: account.address,
      chainId: nonceResponse.data.chainId || 1,
      domain: nonceResponse.data.domain,
      nonce: nonceResponse.data.nonce,
      uri: nonceResponse.data.uri,
      version: nonceResponse.data.version || "1",
      statement: nonceResponse.data.statement,
    });
    const verify = await requestJson("POST", "/api/auth/siwe/verify", {
      body: {
        message,
        signature: await account.signMessage({ message }),
      },
    });
    outcome.verifyStatus = verify.status;
    outcome.token = verify.data?.apiKey ?? null;
    log("token minted", Boolean(outcome.token), "status", verify.status);
    if (verify.status !== 200 || !outcome.token) {
      throw new Error(
        `SIWE verification did not mint an API key (status=${verify.status})`,
      );
    }

    const create = await requestJson("POST", "/api/v1/eliza/agents", {
      token: outcome.token,
      body: {
        agentName: `onb-${account.address.slice(2, 8)}`,
        alwaysOn: true,
      },
    });
    outcome.createStatus = create.status;
    const created = create.data?.data || create.data || {};
    outcome.agentId = created.id || created.agentId || null;
    log(
      "created",
      create.status,
      "id",
      outcome.agentId,
      "tier",
      created.executionTier || created.execution_tier,
      "status",
      created.status,
    );
    if (
      !CREATE_SUCCESS_STATUSES.has(create.status) ||
      typeof outcome.agentId !== "string" ||
      !outcome.agentId
    ) {
      throw new Error(
        `agent creation did not return a usable id (status=${create.status})`,
      );
    }

    const sharedBase = `${API}/api/v1/eliza/agents/${outcome.agentId}`;
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const detail = await requestJson(
        "GET",
        `/api/v1/eliza/agents/${outcome.agentId}`,
        { token: outcome.token },
      );
      const agent = detail.data?.data || detail.data || {};
      const base =
        agent.bridge_url ||
        agent.bridgeUrl ||
        agent.web_ui_url ||
        agent.webUiUrl;
      const status = agent.status || agent.execution_status;
      const chat = await requestJson(
        "POST",
        `/api/conversations/${outcome.agentId}/messages`,
        {
          token: outcome.token,
          base: sharedBase,
          body: { text: "ping" },
        },
      );
      if (
        outcome.firstChatOk === null &&
        chat.status === 200 &&
        typeof chat.data?.text === "string" &&
        chat.data.text.trim()
      ) {
        outcome.firstChatOk = elapsed;
        log(`SHARED CHAT WORKS at t=${elapsed}s`);
      }
      log(
        `t=${elapsed}s status=${status} base=${base ? "Y" : "N"} sharedChat=${chat.status}${
          chat.status !== 200
            ? `(${String(chat.data?.error || chat.data?.text || "").slice(0, 30)})`
            : ""
        }`,
      );
      if (base && (!status || status === "running")) {
        outcome.readyAt = elapsed;
        log(`DEDICATED READY at t=${elapsed}s base=${base}`);
        break;
      }
      await sleep(8000);
    }
  } catch (error) {
    // error-policy:J1 The script boundary still runs cleanup before failing.
    primaryError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (outcome.token && outcome.agentId) {
      try {
        const deletion = await requestJson(
          "DELETE",
          `/api/v1/eliza/agents/${outcome.agentId}`,
          { token: outcome.token },
        );
        outcome.cleanupStatus = deletion.status;
        log("cleanup delete", deletion.status);
      } catch (error) {
        outcome.cleanupError =
          error instanceof Error ? error.message : String(error);
      }
    }
  }

  log("\n=== SUMMARY ===");
  log(
    "shared chat first worked at:",
    outcome.firstChatOk === null ? "NEVER" : `${outcome.firstChatOk}s`,
  );
  log(
    "dedicated container ready at:",
    outcome.readyAt === null ? "TIMED OUT (>10min)" : `${outcome.readyAt}s`,
  );

  let validationError = null;
  let verdict = null;
  try {
    verdict = validateRealCloudOnboardingOutcome(outcome);
  } catch (error) {
    validationError = error instanceof Error ? error : new Error(String(error));
  }
  if (primaryError && validationError) {
    throw new AggregateError(
      [primaryError, validationError],
      "Real Cloud onboarding execution and required outcomes failed",
    );
  }
  if (primaryError) throw primaryError;
  if (validationError) throw validationError;
  log(
    `PASS sharedChat=${verdict.firstChatSeconds}s dedicatedReady=${verdict.dedicatedReadySeconds}s cleanup=${verdict.cleanupStatus}`,
  );
  return verdict;
}

const invokedAsScript =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    // error-policy:J1 Process exit is translated once at the script boundary.
    log("FATAL", errorReport(error));
    process.exitCode = 1;
  });
}
