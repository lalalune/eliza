/**
 * Verifies Discord desktop OAuth teardown against deliberately delayed token
 * responses that ignore abort, using a real temporary session file.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import discordLocalPlugin, {
	DiscordLocalService,
} from "../discord-local-service";

type Session = {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	scopes: string[];
};

type AuthHarness = {
	session: Session | null;
	sessionPath: string;
	exchangeAuthorizationCode(code: string): Promise<void>;
	refreshAccessToken(): Promise<void>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function tokenResponse(accessToken: string): Response {
	return new Response(
		JSON.stringify({
			access_token: accessToken,
			refresh_token: `${accessToken}-refresh`,
			expires_in: 3600,
			scope: "rpc identify",
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

describe("DiscordLocalService auth quiescence", () => {
	let stateDir: string;
	let previousStateDir: string | undefined;
	let service: DiscordLocalService;
	let runtime: IAgentRuntime;

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "discord-auth-stop-"));
		previousStateDir = process.env.ELIZA_STATE_DIR;
		process.env.ELIZA_STATE_DIR = stateDir;
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

		const settings = new Map<string, string>([
			["DISCORD_LOCAL_CLIENT_ID", "client-id"],
			["DISCORD_LOCAL_CLIENT_SECRET", "client-secret"],
		]);
		runtime = {
			getSetting: (key: string) => settings.get(key),
			getService: () => service,
		} as unknown as IAgentRuntime;
		service = new DiscordLocalService(runtime);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (previousStateDir === undefined) {
			delete process.env.ELIZA_STATE_DIR;
		} else {
			process.env.ELIZA_STATE_DIR = previousStateDir;
		}
		await rm(stateDir, { recursive: true, force: true });
	});

	it("stop aborts and drains a refresh without allowing a late session write", async () => {
		const harness = service as unknown as AuthHarness;
		const originalSession: Session = {
			accessToken: "original-access",
			refreshToken: "original-refresh",
			expiresAt: Date.now() - 1,
			scopes: ["rpc"],
		};
		harness.session = originalSession;
		await writeFile(
			harness.sessionPath,
			JSON.stringify(originalSession, null, 2),
			"utf8",
		);

		const fetchStarted = deferred<void>();
		const delayedResponse = deferred<Response>();
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				signal = init?.signal ?? undefined;
				fetchStarted.resolve();
				return delayedResponse.promise;
			}),
		);

		const refresh = harness.refreshAccessToken();
		const refreshRejection = expect(refresh).rejects.toThrow(
			"Discord local authentication was stopped",
		);
		await fetchStarted.promise;
		const stop = service.stop();
		expect(signal?.aborted).toBe(true);

		let stopSettled = false;
		void stop.then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		expect(stopSettled).toBe(false);

		delayedResponse.resolve(tokenResponse("late-access"));
		await refreshRejection;
		await stop;
		expect(stopSettled).toBe(true);
		expect(JSON.parse(await readFile(harness.sessionPath, "utf8"))).toEqual(
			originalSession,
		);
		expect(harness.session).toBeNull();
		await expect(harness.refreshAccessToken()).rejects.toThrow(
			"Discord local service is stopped",
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("plugin disposal drains an exchange without creating a session file", async () => {
		const harness = service as unknown as AuthHarness;
		const fetchStarted = deferred<void>();
		const delayedResponse = deferred<Response>();
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				signal = init?.signal ?? undefined;
				fetchStarted.resolve();
				return delayedResponse.promise;
			}),
		);

		const exchange = harness.exchangeAuthorizationCode("authorization-code");
		const exchangeRejection = expect(exchange).rejects.toThrow(
			"Discord local authentication was stopped",
		);
		await fetchStarted.promise;
		if (!discordLocalPlugin.dispose) {
			throw new Error("discord-local plugin must provide a dispose hook");
		}
		const dispose = Promise.resolve(discordLocalPlugin.dispose(runtime));
		expect(signal?.aborted).toBe(true);

		delayedResponse.resolve(tokenResponse("late-exchange"));
		await exchangeRejection;
		await dispose;
		expect(existsSync(harness.sessionPath)).toBe(false);
		expect(harness.session).toBeNull();
		await expect(
			harness.exchangeAuthorizationCode("another-code"),
		).rejects.toThrow("Discord local service is stopped");
		expect(fetch).toHaveBeenCalledOnce();
	});
});
