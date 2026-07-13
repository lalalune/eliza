/**
 * Pins the app-control view bundle's host-external module boundary.
 */

import { describe, expect, it } from "vitest";
import viewBundleConfig from "../../vite.config.views";

function externalPredicate(): (id: string) => boolean {
	const external = viewBundleConfig.build?.rollupOptions?.external;
	if (typeof external !== "function") {
		throw new Error(
			"app-control view bundle must define an external predicate",
		);
	}
	return external as (id: string) => boolean;
}

describe("app-control view bundle externals", () => {
	it("keeps core and its subpaths on the host without widening the boundary", () => {
		const external = externalPredicate();

		expect(external("@elizaos/core")).toBe(true);
		expect(external("@elizaos/core/plugin")).toBe(true);
		expect(external("@elizaos/logger")).toBe(false);
	});
});
