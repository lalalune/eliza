/**
 * Composes the public plugin/index behavior matrix around completion parsing,
 * progress cadence, spawn acknowledgements, and import-time registration.
 * The constituent suites keep runtime seams deterministic and model-free.
 */

import { vi } from "vitest";
import "./extract-completion-summary.test.ts";
import "./live-smoke-imports.test.ts";
import "./progress-cadence.test.ts";
import "./sanitize-planner-text.test.ts";
import "./spawn-ack.test.ts";
import "./strip-progress-label-prefix.test.ts";

// A direct Vitest dependency keeps this composed lane on the same runner as
// its constituent suites when changed-test selection inspects imports.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
