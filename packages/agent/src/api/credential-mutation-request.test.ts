/** Verifies credential-producing read routes participate in reset admission. */

import { describe, expect, it } from "vitest";
import { requestMayMutateCredentialState } from "./credential-mutation-request.ts";

describe("requestMayMutateCredentialState", () => {
  it("classifies health callbacks and feed authentication reads as mutations", () => {
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/lifeops/connectors/health/strava/callback",
      ),
    ).toBe(true);
    expect(
      requestMayMutateCredentialState("GET", "/api/apps/feed/timeline"),
    ).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/setup/telegram-account/status",
      ),
    ).toBe(true);
    expect(requestMayMutateCredentialState("GET", "/api/discord/guilds")).toBe(
      true,
    );
    expect(
      requestMayMutateCredentialState("GET", "/api/discord/channels"),
    ).toBe(true);
    expect(requestMayMutateCredentialState("GET", "/api/discord/guilds/")).toBe(
      true,
    );
    expect(requestMayMutateCredentialState("GET", "/api/accounts")).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/accounts/openai-codex/oauth/status",
      ),
    ).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/api/secrets/manager/preferences",
      ),
    ).toBe(true);
    expect(
      requestMayMutateCredentialState(
        "GET",
        "/internal/account-pool/v1/health",
      ),
    ).toBe(true);
  });

  it("keeps chat and unrelated reads outside the reset drain", () => {
    expect(
      requestMayMutateCredentialState("POST", "/v1/chat/completions"),
    ).toBe(false);
    expect(requestMayMutateCredentialState("GET", "/api/health")).toBe(false);
  });
});
