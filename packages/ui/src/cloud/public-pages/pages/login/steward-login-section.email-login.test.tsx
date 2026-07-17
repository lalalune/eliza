/**
 * Email magic-link companion-code login coverage. The Steward HTTP adapter is
 * doubled so these tests can assert the login state machine: code redemption
 * establishes the session, while remote link approval polling only updates UI.
 */

// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emailLoginSpies = vi.hoisted(() => ({
  start: vi.fn(),
  verify: vi.fn(),
  poll: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  sync: vi.fn(),
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getProviders() {
      return Promise.resolve({
        passkey: false,
        email: true,
        siwe: false,
        siws: false,
        google: false,
        discord: false,
        github: false,
        twitter: false,
        oauth: [],
      });
    }
    getSession() {
      return null;
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test/steward",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/steward-email-login", () => ({
  StewardEmailLoginError: class StewardEmailLoginError extends Error {
    status: number;
    upstreamCode: string | undefined;
    constructor(
      message: string,
      options: { status: number; upstreamCode?: string },
    ) {
      super(message);
      this.name = "StewardEmailLoginError";
      this.status = options.status;
      this.upstreamCode = options.upstreamCode;
    }
  },
  startStewardEmailLogin: emailLoginSpies.start,
  verifyStewardEmailSignInCode: emailLoginSpies.verify,
  pollStewardEmailSignInStatus: emailLoginSpies.poll,
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: vi.fn(),
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/dashboard",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

function renderSection(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

async function startEmailLogin() {
  const input = await screen.findByPlaceholderText("you@example.com");
  fireEvent.change(input, { target: { value: "person@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));
  await screen.findByLabelText("Six-digit code");
}

describe("StewardLoginSection email magic-link companion code", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    emailLoginSpies.start.mockResolvedValue({
      expiresAtMs: Date.now() + 600_000,
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
    });
    emailLoginSpies.verify.mockResolvedValue({
      mfaRequired: false,
      token: "session-token",
      refreshToken: "refresh-token",
    });
    emailLoginSpies.poll.mockResolvedValue("pending");
    sessionSpies.sync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("redeems only six digits and establishes the session from the verify response", async () => {
    renderSection();
    await startEmailLogin();

    const codeInput = screen.getByLabelText("Six-digit code");
    fireEvent.change(codeInput, { target: { value: "12a345678" } });
    expect((codeInput as HTMLInputElement).value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: /Verify code/i }));

    await waitFor(() =>
      expect(emailLoginSpies.verify).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://api.example.test/steward",
          tenantId: "elizacloud",
          signal: expect.any(AbortSignal),
        }),
        "person@example.com",
        "123456",
      ),
    );
    await waitFor(() =>
      expect(sessionSpies.sync).toHaveBeenCalledWith(
        "session-token",
        "refresh-token",
      ),
    );
  });

  it("remote consumed status shows approval guidance without syncing a session", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Link approved")).toBeTruthy();
    expect(
      screen.getByText(
        "The link was approved elsewhere. This device was not signed in.",
      ),
    ).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("shows expired and replay guidance for a rejected code", async () => {
    const { StewardEmailLoginError } = await import(
      "../../lib/steward-email-login"
    );
    emailLoginSpies.verify.mockRejectedValue(
      new StewardEmailLoginError("already used", {
        code: "STEWARD_EMAIL_LOGIN_HTTP_FAILED",
        status: 410,
        upstreamCode: "challenge_consumed",
      }),
    );
    renderSection();
    await startEmailLogin();

    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Verify code/i }));

    expect(
      await screen.findByText(
        "That sign-in email expired or was already used. Request a new email.",
      ),
    ).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("renders locked and expired polling states", async () => {
    emailLoginSpies.poll.mockResolvedValueOnce("locked");
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Too many attempts")).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();

    cleanup();
    vi.clearAllMocks();
    emailLoginSpies.start.mockResolvedValue({
      expiresAtMs: Date.now() + 600_000,
      challengeId: "challenge-2",
      pollSecret: "poll-secret-2",
    });
    emailLoginSpies.poll.mockResolvedValueOnce("expired");
    sessionSpies.sync.mockResolvedValue(undefined);

    renderSection();
    await startEmailLogin();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Email expired")).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("keeps code entry usable while a failed poll retries with backoff", async () => {
    emailLoginSpies.poll
      .mockRejectedValueOnce(new Error("status transport unavailable"))
      .mockResolvedValue("pending");
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(
      await screen.findByText("status transport unavailable"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Six-digit code").hasAttribute("disabled"),
    ).toBe(false);
    expect(emailLoginSpies.poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(emailLoginSpies.poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(emailLoginSpies.poll).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByText("status transport unavailable")).toBeNull(),
    );
  });

  it("expires from the validated server timestamp before the next poll", async () => {
    emailLoginSpies.start.mockResolvedValue({
      expiresAtMs: Date.now() + 1_000,
      challengeId: "challenge-expiring",
      pollSecret: "poll-secret-expiring",
    });
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(await screen.findByText("Email expired")).toBeTruthy();
    expect(emailLoginSpies.poll).not.toHaveBeenCalled();
  });

  it("preserves the magic-link-only state only when both polling credentials are absent", async () => {
    emailLoginSpies.start.mockResolvedValue({
      expiresAtMs: Date.now() + 600_000,
    });
    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));

    expect(
      await screen.findByText(
        "Check your inbox and open the magic link to sign in.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(emailLoginSpies.poll).not.toHaveBeenCalled();
  });

  it("aborts an in-flight challenge start when the login surface unmounts", async () => {
    let startSignal: AbortSignal | undefined;
    emailLoginSpies.start.mockImplementation(
      (options: { signal?: AbortSignal }) => {
        startSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const rendered = renderSection();
    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));
    await waitFor(() => expect(startSignal).toBeDefined());
    expect(startSignal?.aborted).toBe(false);

    rendered.unmount();
    await Promise.resolve();
    expect(startSignal?.aborted).toBe(true);
  });

  it("allows only one in-flight verification for repeated activation", async () => {
    let resolveVerification:
      | ((value: {
          mfaRequired: false;
          token: string;
          refreshToken: string;
        }) => void)
      | undefined;
    emailLoginSpies.verify.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVerification = resolve;
        }),
    );
    renderSection();
    await startEmailLogin();

    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    const verifyButton = screen.getByRole("button", { name: /Verify code/i });
    fireEvent.click(verifyButton);
    fireEvent.click(verifyButton);
    expect(emailLoginSpies.verify).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveVerification?.({
        mfaRequired: false,
        token: "session-token",
        refreshToken: "refresh-token",
      });
    });
    await waitFor(() => expect(sessionSpies.sync).toHaveBeenCalledTimes(1));
  });

  it("aborts an in-flight verification when the login surface unmounts", async () => {
    let verificationSignal: AbortSignal | undefined;
    emailLoginSpies.verify.mockImplementation(
      (options: { signal?: AbortSignal }) => {
        verificationSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const rendered = renderSection();
    await startEmailLogin();

    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Verify code/i }));
    expect(verificationSignal?.aborted).toBe(false);

    rendered.unmount();
    await Promise.resolve();
    expect(verificationSignal?.aborted).toBe(true);
  });
});
