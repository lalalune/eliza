# TraceId Export Filter Follow-Up

## Scope

- `TrajectoriesService.exportTrajectoriesZip()` now forwards `traceId` into the
  list query it uses when no explicit trajectory IDs are provided.
- `/api/trajectories` list, JSON/JSONL export, and ZIP export all accept and
  forward `traceId`.
- `/api/training/trajectories/export` accepts `traceId`, forwards it to the
  training service list call, and records the requested trace in bundle source
  metadata.

## Verification

- `node packages/shared/scripts/generate-keywords.mjs --target ts` passed.
- `bun test plugins/plugin-training/src/routes/trajectory-routes.test.ts plugins/plugin-training/src/core/trajectory-export-bundle.test.ts plugins/plugin-training/src/services/training-service.test.ts`:
  - Passed the new `/api/trajectories` `traceId` propagation regression.
  - Passed `TrainingService.buildDataset` coverage.
  - Passed the updated training export bundle regression.
  - The broader `trajectory-export-bundle.test.ts` file then timed out in the
    existing `lets the training collection route pull natural runtime
    trajectories` case after failing to find a generated README in its temp
    output. That case is outside this traceId plumbing change.
- `bunx @biomejs/biome check packages/core/src/features/trajectories/TrajectoriesService.ts plugins/plugin-training/src/routes/trajectory-routes.ts plugins/plugin-training/src/routes/training-routes.ts plugins/plugin-training/src/services/training-service.ts plugins/plugin-training/src/services/training-service-like.ts plugins/plugin-training/src/routes/trajectory-routes.test.ts plugins/plugin-training/src/core/trajectory-export-bundle.test.ts --no-errors-on-unmatched` passed with pre-existing warnings in touched test/route files.
- `git diff --check` passed.

## Manual Review

Reviewed the changed route and service boundaries by hand. The filter now
survives every path that can expand a trace-scoped request into trajectory IDs:
core ZIP export, plugin-training `/api/trajectories` list/export, and
plugin-training rich bundle export.
