/**
 * Pins the trajectory barrel after removing reward helpers that fabricated results.
 */

import { describe, expect, it } from "vitest";
import * as trajectories from "./index";

describe("trajectories module surface", () => {
	it("keeps live exports without the removed reward placeholders", () => {
		const surface = trajectories as Record<string, unknown>;
		for (const removed of [
			"computeTrajectoryReward",
			"computeStepReward",
			"buildGameStateFromDB",
			"recomputeTrajectoryRewards",
		]) {
			expect(surface[removed]).toBeUndefined();
		}

		expect(trajectories.TrajectoriesService).toBeTypeOf("function");
		expect(trajectories.trajectoriesPlugin).toBeTypeOf("object");
	});
});
