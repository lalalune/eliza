/**
 * Browser HTTP adapter for Steward's shared magic-link and companion-code flow.
 *
 * The UI calls the additive endpoints directly while deployed Steward SDKs may
 * lag the API. Every response is validated at this boundary so an upstream
 * rollout fault cannot masquerade as a valid challenge or authenticated session.
 */

import { ElizaError } from "@elizaos/core";

export type StewardEmailLoginStatus =
  | "pending"
  | "consumed"
  | "locked"
  | "expired"
  | "invalid";

export interface StewardEmailLoginChallenge {
  expiresAtMs: number;
  challengeId?: string;
  pollSecret?: string;
}

export type StewardEmailCodeVerificationResult =
  | { mfaRequired: true }
  | {
      mfaRequired: false;
      token: string;
      refreshToken?: string | null;
    };

interface StewardEmailLoginOptions {
  baseUrl: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

type StewardEmailLoginErrorCode =
  | "STEWARD_EMAIL_LOGIN_HTTP_FAILED"
  | "STEWARD_EMAIL_LOGIN_RESPONSE_INVALID"
  | "STEWARD_EMAIL_LOGIN_TRANSPORT_FAILED";

interface StewardEmailLoginErrorOptions {
  code: StewardEmailLoginErrorCode;
  status: number;
  upstreamCode?: string;
  cause?: unknown;
}

export class StewardEmailLoginError extends ElizaError {
  override readonly name = "StewardEmailLoginError";
  readonly status: number;
  readonly upstreamCode?: string;

  constructor(message: string, options: StewardEmailLoginErrorOptions) {
    super(message, {
      code: options.code,
      context: {
        status: options.status,
        ...(options.upstreamCode ? { upstreamCode: options.upstreamCode } : {}),
      },
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.status >= 500 || options.status === 0
        ? { severity: "ephemeral" as const }
        : {}),
    });
    this.status = options.status;
    this.upstreamCode = options.upstreamCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function malformedResponse(
  message: string,
  status = 502,
  cause?: unknown,
): StewardEmailLoginError {
  return new StewardEmailLoginError(message, {
    code: "STEWARD_EMAIL_LOGIN_RESPONSE_INVALID",
    status,
    ...(cause !== undefined ? { cause } : {}),
  });
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    // error-policy:J2 Preserve the HTTP context when malformed JSON crosses the adapter boundary.
    throw malformedResponse(
      "Steward email sign-in returned malformed JSON.",
      response.ok ? 502 : response.status || 502,
      cause,
    );
  }
}

function unwrapResponseData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw malformedResponse(
      "Steward email sign-in returned a malformed response.",
    );
  }
  if (!("data" in payload)) return payload;
  if (!isRecord(payload.data)) {
    throw malformedResponse(
      "Steward email sign-in returned malformed response data.",
    );
  }
  return payload.data;
}

function upstreamFailureDetails(payload: unknown): {
  message?: string;
  upstreamCode?: string;
} {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.error)) {
    return {
      message: readString(payload.error.message),
      upstreamCode: readString(payload.error.code) ?? readString(payload.code),
    };
  }
  return {
    message: readString(payload.error),
    upstreamCode: readString(payload.code),
  };
}

async function request(
  options: StewardEmailLoginOptions,
  path: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `${options.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          options.tenantId ? { ...body, tenantId: options.tenantId } : body,
        ),
        signal: options.signal,
      },
    );
  } catch (cause) {
    // error-policy:J2 Preserve network and abort failures for the UI boundary.
    throw new StewardEmailLoginError("Steward email sign-in request failed.", {
      code: "STEWARD_EMAIL_LOGIN_TRANSPORT_FAILED",
      status: 0,
      cause,
    });
  }

  const payload = await readResponseJson(response);
  if (!response.ok) {
    const details = upstreamFailureDetails(payload);
    throw new StewardEmailLoginError(
      details.message || "Steward email sign-in failed.",
      {
        code: "STEWARD_EMAIL_LOGIN_HTTP_FAILED",
        status: response.status,
        ...(details.upstreamCode ? { upstreamCode: details.upstreamCode } : {}),
      },
    );
  }
  return unwrapResponseData(payload);
}

function parseExpiryMs(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw malformedResponse(
        "Steward email sign-in returned an invalid expiry timestamp.",
      );
    }
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  throw malformedResponse(
    "Steward email sign-in returned an invalid expiry timestamp.",
  );
}

export async function startStewardEmailLogin(
  options: StewardEmailLoginOptions,
  email: string,
): Promise<StewardEmailLoginChallenge> {
  const data = await request(options, "/auth/email/send", { email });
  const expiresAtMs = parseExpiryMs(data.expiresAt);
  const challengeId = readNonEmptyString(data.challengeId);
  const pollSecret = readNonEmptyString(data.pollSecret);
  if (Boolean(challengeId) !== Boolean(pollSecret)) {
    throw malformedResponse(
      "Steward email sign-in returned incomplete polling credentials.",
    );
  }
  return challengeId && pollSecret
    ? { expiresAtMs, challengeId, pollSecret }
    : { expiresAtMs };
}

export async function verifyStewardEmailSignInCode(
  options: StewardEmailLoginOptions,
  email: string,
  code: string,
): Promise<StewardEmailCodeVerificationResult> {
  const data = await request(options, "/auth/email/code/verify", {
    email,
    code,
  });
  if (data.mfaRequired === true) return { mfaRequired: true };

  const token = readNonEmptyString(data.token);
  if (!token) {
    throw malformedResponse(
      "Steward email sign-in returned an authenticated response without a token.",
    );
  }
  const refreshTokenValue = data.refreshToken;
  let refreshToken: string | null | undefined;
  if (refreshTokenValue === null) {
    refreshToken = null;
  } else if (refreshTokenValue !== undefined) {
    refreshToken = readNonEmptyString(refreshTokenValue);
    if (!refreshToken) {
      throw malformedResponse(
        "Steward email sign-in returned an invalid refresh token.",
      );
    }
  }
  return {
    mfaRequired: false,
    token,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

export async function pollStewardEmailSignInStatus(
  options: StewardEmailLoginOptions,
  challengeId: string,
  pollSecret: string,
): Promise<StewardEmailLoginStatus> {
  const data = await request(options, "/auth/email/status", {
    challengeId,
    pollSecret,
  });
  const status = readString(data.status);
  if (
    status !== "pending" &&
    status !== "consumed" &&
    status !== "locked" &&
    status !== "expired" &&
    status !== "invalid"
  ) {
    throw malformedResponse(
      "Steward email sign-in returned an invalid challenge status.",
    );
  }
  return status;
}
