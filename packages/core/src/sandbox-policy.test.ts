/**
 * Exercises the local-code execution policy against the process-wide build
 * variant cache and verifies the store-build recovery message.
 */

import { afterEach, describe, expect, it } from "vitest";
import { _resetBuildVariantForTests } from "./build-variant.ts";
import {
	buildStoreVariantBlockedMessage,
	isLocalCodeExecutionAllowed,
} from "./sandbox-policy.ts";

const ORIGINAL_VARIANT = process.env.ELIZA_BUILD_VARIANT;

function setBuildVariant(variant: string | undefined): void {
	if (variant === undefined) {
		delete process.env.ELIZA_BUILD_VARIANT;
	} else {
		process.env.ELIZA_BUILD_VARIANT = variant;
	}
	_resetBuildVariantForTests();
}

afterEach(() => {
	setBuildVariant(ORIGINAL_VARIANT);
});

describe("sandbox policy", () => {
	it("allows local code execution only in direct builds", () => {
		setBuildVariant("direct");
		expect(isLocalCodeExecutionAllowed()).toBe(true);

		setBuildVariant("store");
		expect(isLocalCodeExecutionAllowed()).toBe(false);
	});

	it("defaults unknown build variants to the direct build", () => {
		process.env.ELIZA_BUILD_VARIANT = "unsupported";
		_resetBuildVariantForTests();

		expect(isLocalCodeExecutionAllowed()).toBe(true);
	});

	it("directs store users to the unrestricted download", () => {
		expect(buildStoreVariantBlockedMessage("Coding agents")).toBe(
			"Coding agents requires the direct download build of Eliza. " +
				"Store-distributed builds run in an OS sandbox that blocks forking user-installed CLIs. " +
				"To use this feature, install from https://eliza.so/download.",
		);
	});
});
