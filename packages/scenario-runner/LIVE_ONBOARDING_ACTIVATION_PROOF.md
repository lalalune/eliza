# Live post-sign-in onboarding proof

This proof covers the agent behavior immediately after authentication:

1. The scenario invokes the production durable post-sign-in activation helper
   for the simulated owner and requires the exact activation copy, greeting
   kind, version, stable message ID, and exactly one persisted message. A retry
   must preserve that identity while returning empty text with
   `generated=false` and `persisted=false`, preventing a visible replay.
2. The owner states a concrete problem through
   `runtime.messageService.handleMessage`; this is a normal message turn through
   the real agent/model loop.
3. The response must acknowledge that problem instead of repeating the initial
   “what do you want help with?” question.
4. The real merged response evaluator must extract the goal and persist both
   the FTU lifecycle record and canonical `primaryGoal` owner fact. The scenario
   only reads those records for its final assertion; it never invokes the
   evaluator or writes the goal directly.
5. Raw trajectory JSON, the run viewer, aggregate report, and native JSONL are
   generated and independently validated. The trajectory-service database is
   also preserved and its model calls exported to `model-calls.json`, which
   captures the merged evaluator input and output that occur after the message
   runtime's native file trajectory closes. Proxy mode, missing credentials,
   skips, missing artifacts, a deterministic provider, or absent evaluator
   input/output all fail the command.

Run from the repository root:

```bash
bun run --cwd packages/scenario-runner test:live:onboarding-activation
```

Set one supported live-provider credential (`CEREBRAS_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`, or `OPENROUTER_API_KEY`), or
use an authenticated subscription CLI through `ELIZA_CHAT_VIA_CLI`.

When a machine has several credentials, select and isolate one provider with
`LIVE_ONBOARDING_LLM_PROVIDER=groq|openai|cerebras|anthropic|google|openrouter|cli`.
This also prevents unrelated OpenAI-compatible endpoint/model settings from
being paired with the wrong credential.

To choose an evidence directory:

```bash
bun run --cwd packages/scenario-runner test:live:onboarding-activation -- \
  --out /absolute/path/to/evidence
```

The directory contains:

- `report.json` and `report/` — aggregate and per-scenario results;
- `run/viewer/index.html` — trajectory/run reviewer;
- `run/trajectories/` — raw model inputs, outputs, and stage metadata;
- `model-calls.json` — full response-handler and merged-evaluator model calls;
- `pglite/` — preserved real runtime and trajectory-service database;
- `native.jsonl` plus its manifest/privacy attestation;
- `runner.stdout.log` and `runner.stderr.log`;
- `validation.json` — the wrapper’s fail-closed artifact verdict.

## Boundary of this proof

This scenario proves the production activation primitive and the complete
agent/model/evaluator/persistence handoff. It does not claim that an OAuth,
email, passkey, wallet, or device sign-in UI triggered the activation request.
That browser/device trigger must be proven by the corresponding app E2E lane.
In particular, the current app `cloud-live.spec.ts` preloads a validated Cloud
bearer into browser storage; it proves authenticated onboarding, provisioning,
and chat against live Cloud, but it does not exercise interactive sign-in.
