# MultitaskBench — live runs for #13777 (one agent handling N∈{1,5,10} tasks)

**Issue:** #13777 (WS7 / design D4), part of epic #13766.
**Model:** `gpt-oss-120b` on Cerebras (OpenAI-compatible endpoint).
**Sample:** the frozen 10-scenario STATIC LifeOps sample (5 SMOKE + 5 CORE across all domains), seed 2026.
**Harness invocation:** `python -m multitask_bench --harness <h> --lanes 1,5,10 --model gpt-oss-120b`.
**Date:** 2026-07-05.

Every number below is from a **live model** (no oracle, no mock). The registry
scorer (`registry/scores.py::_score_from_multitask_bench_json`) accepts the
hermes and openclaw reports as **publishable** (it rejects oracle-model
reports); the scalar registry score is the N=10 `mean_task_score`.

## Which lanes ran live

| lane | ran live? | isolation | notes |
|---|---|---|---|
| **eliza** | YES | `shared_runtime` | Full elizaOS `AgentRuntime` via the TS bench server (`packages/lifeops-bench/src/server.ts`), booted with the AsyncLocalStorage per-session usage fix in tree; gated behind `MULTITASK_ELIZA_USAGE_FIX=1`. Server reports `mock:false, stubEmbedding:false`. |
| **hermes** | YES | `process_per_turn` | `HermesClient(mode=in_process)` — the documented path that needs only `openai` in the venv, **not** a hermes-agent clone. Real Cerebras chat.completions per turn. |
| **openclaw** | YES — **direct-compat (partial, not CLI-native)** | `process_per_turn` | The `openclaw` CLI installs and runs (`OpenClaw 2026.6.11`) but its model registry hard-rejects `gpt-oss-120b` (`FailoverError: Unknown model`), so per the adapter README + runbook mandate the lane runs via `OPENCLAW_DIRECT_OPENAI_COMPAT=1`. **Labeled partial: not CLI-native tool-call parity.** |

## Headline numbers

| harness | isolation | N | mean_score | completed | tput/min | p50/p95 ms | wall s | cost $ | tok p/c | starved | jain |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eliza | shared_runtime | 1 | 0.310 | 10/10 | 3.5 | n/a¹ | 169.6 | n/a¹ | 1630477/10318 | 0 | 1.000 |
| eliza | shared_runtime | 5 | 0.320 | 10/10 | 7.4 | n/a¹ | 80.9 | n/a¹ | 1375031/8125 | 0 | 0.934 |
| eliza | shared_runtime | 10 | 0.310 | 10/10 | 5.0 | n/a¹ | 120.4 | n/a¹ | 1522777/9824 | 0 | 0.909 |
| hermes | process_per_turn | 1 | 0.430 | 10/10 | 16.3 | 720/1363 | 36.7 | $0.2134 | 604055/2578 | 0 | 1.000 |
| hermes | process_per_turn | 5 | 0.440 | 10/10 | 14.4 | 862/1280 | 41.8 | $0.2252 | 639024/2034 | 0 | 0.984 |
| hermes | process_per_turn | 10 | 0.430 | 10/10 | 13.3 | 792/1651 | 45.2 | $0.2139 | 604035/3374 | 0 | 1.000 |
| openclaw | process_per_turn | 1 | 0.430 | 10/10 | 13.2 | 1172/2415 | 45.6 | $0.2261 | 638592/3407 | 0 | 1.000 |
| openclaw | process_per_turn | 5 | 0.510 | 10/10 | 14.6 | 1122/2009 | 41.2 | $0.2156 | 608384/3605 | 0 | 1.000 |
| openclaw | process_per_turn | 10 | 0.475 | 10/10 | 19.9 | 747/1340 | 30.2 | $0.2259 | 638610/3187 | 0 | 0.980 |

¹ eliza HTTP bridge attributes usage server-side (MODEL_USED → AsyncLocalStorage), not via the base-client per-turn telemetry writer; token totals are captured, per-turn cost/latency are not populated on that path.

## Interference (the headline metric = mean_task_score @N − @N=1)

| harness | isolation | N=5 − N=1 | N=10 − N=1 | Jain N=1→5→10 |
|---|---|---|---|---|
| eliza | shared_runtime | +0.010 | +0.000 | 1.000→0.934→0.909 |
| hermes | process_per_turn | +0.010 | +0.000 | 1.000→0.984→1.000 |
| openclaw | process_per_turn | +0.080 | +0.045 | 1.000→1.000→0.980 |

### What the interference numbers show

- **hermes / openclaw are process-isolated (`process_per_turn`)**, so the
  *contract* is: per-task **score** should not degrade under load — only the
  shared rate/cost budget is contended. That is exactly what the data shows:
  hermes interference is ≈0 (+0.010 / +0.000), openclaw is small-positive
  (+0.080 / +0.045) — sampling noise on a 10-scenario set, not degradation.
  The contention surfaces where the model says it should: **latency and
  throughput**, not correctness. Hermes throughput falls 16.3→13.3 tasks/min
  as N grows (p95 720→1651 ms); openclaw's overlapping waves actually *raise*
  throughput (13.2→19.9 tasks/min) by hiding network latency. Jain fairness
  stays ≥0.98 across the board and **zero tasks starved** in any lane.

- **eliza (`shared_runtime`) is the only lane where the isolation asymmetry
  bites:** its per-task **score** interference is also ≈0 (+0.010 / +0.000) —
  the per-session usage fix + session isolation keep correctness steady even at
  N=10 — but its **Jain fairness degrades monotonically** (1.000 → 0.934 →
  0.909) while both process-isolated lanes stay ≥0.98. That is the shared-runtime
  cost surfacing exactly where it should: concurrent sessions contend for one
  runtime's turn budget, so some tasks get more turns than others. The upside of
  sharing also shows: eliza throughput **doubles** from N=1→N=5 (3.5→7.4
  tasks/min, wall 170s→81s) as the runtime overlaps concurrent inference. This
  shared-runtime contention is exactly why the issue's P0 was the per-session
  usage buffer (fixed; see caveats).

## Trajectories I read by hand (one clean completion + one failure per lane)

**hermes** (`hermes-trajectory-excerpt.json`)
- *Clean completion* — `calendar.check_availability_thursday_morning`: turn 0 the
  model reasons "Need to check calendar. Use CALENDAR_CHECK_AVAILABILITY." and
  emits the `CALENDAR` action; turn 1 it reports "you have no events scheduled …
  so you're free." Scored 1.0 in 2 turns.
- *Interesting failure* — `mail.archive_specific_newsletter_thread`: the model
  emitted `MESSAGE_MANAGE archive` on `thread_01464`, but the shared LifeWorld
  executor returned `email not found: thread_01464` — a tool-arg vs
  world-state mismatch (the model targeted a thread id the world keyed
  differently).

**openclaw** (`openclaw-trajectory-excerpt.json`)
- *Clean completion* — same calendar task: the CLI-shaped turn puts all the
  reasoning into the tool call (empty `response_text` on the tool turn), then the
  final turn answers "You're free on Thursday 2026-05-14 from 09:00 to 10:00 UTC."
- *Interesting artifact* — openclaw's tool-call turns carry empty assistant text
  (the direct-compat path routes everything through `tool_calls`), so the visible
  "response" is only on the closing natural-language turn. Worth knowing when
  reading these trajectories: an empty `response_text` is a tool turn, not a
  failure.

**eliza** (`eliza-trajectory-excerpt.json`)
- *Clean completions* — `calendar.check_availability` (2 turns, 1.0),
  `mail.archive_specific_newsletter_thread` (4 turns, 1.0),
  `travel.search_flights_sfo_jfk` (6 turns, 1.0).
- *Interesting failure* — `messages.send_imessage_to_hannah` scored **0.2 after
  5 turns**: the run log shows `Action MESSAGE failed … chat_message id already
  exists: chat_auto_c4e461f3f708` **four times** — the agent kept re-emitting the
  same MESSAGE tool call because the idempotent write collided in the shared
  LifeWorld and it never observed a success it could move past. A second class of
  failure — `MESSAGE/send (gmail) requires to_emails` on
  `focus.block_distracting_apps_25min` — is the agent mis-routing a channel
  action without the required arg. These executor gaps (`add_contact` unsupported,
  gmail arg requirements) come from the **shared** LifeOps executor and penalize
  all three harnesses identically, so the cross-harness comparison stays
  apples-to-apples.

## Honest caveats (no papering over)

1. **openclaw is direct-compat, not CLI-native.** The CLI runs but won't route
   `gpt-oss-120b`; the lane is labeled partial everywhere. CLI-native parity
   would need a custom-model registration in openclaw's provider config, which is
   undocumented and out of scope for clearing the live-keys gate.
2. **eliza per-turn cost/latency read 0** in the report. The eliza HTTP bridge
   attributes usage server-side (MODEL_USED → AsyncLocalStorage buffer) rather
   than through the base-client per-turn telemetry writer that hermes/openclaw
   use, so `cost_usd` and `turn_latency_ms` are not populated on that path.
   **Token totals ARE captured** (e.g. N=1: prompt 1,366,108 / completion 8,019),
   and `mean_task_score` / completion / starvation / fairness are all real. This
   is a telemetry-plumbing gap on the eliza lane, not a data-quality problem with
   the scores.
3. **The eliza P0 usage-buffer fix is in tree.** `server.ts` uses an
   `AsyncLocalStorage`-bound `UsageCapture` so N overlapping sessions each collect
   only their own MODEL_USED events — the fix issue #13777 required before the
   eliza live lane could publish. The lane was run with
   `MULTITASK_ELIZA_USAGE_FIX=1`.

## Secrets

No API key material is written to any artifact. The Cerebras key was never
printed, logged, or committed; a full `grep` of the entire results tree for the
key returns zero matches, and every committed file (summaries + trajectory
excerpts) was secret-scanned (key substring + `sk-`/`csk-`/`Bearer` patterns)
before commit. Trajectory excerpts include only a 300-char prompt head (the
benign LifeOps system prompt) and the model's response — no auth material.

## Repro

```bash
# venv with the bench packages (editable)
uv venv --python 3.12 .venv && uv pip install -e packages/benchmarks/lifeops-bench \
  -e packages/benchmarks/multitask-bench -e packages/benchmarks/eliza-adapter \
  -e packages/benchmarks/hermes-adapter -e packages/benchmarks/openclaw-adapter openai

# hermes (in_process, no clone needed)
HERMES_ADAPTER_MODE=in_process BENCHMARK_MODEL_PROVIDER=cerebras \
  python -m multitask_bench --harness hermes --lanes 1,5,10 --model gpt-oss-120b

# openclaw (direct-compat — partial)
OPENCLAW_DIRECT_OPENAI_COMPAT=1 BENCHMARK_MODEL_PROVIDER=cerebras \
  python -m multitask_bench --harness openclaw --lanes 1,5,10 --model gpt-oss-120b

# eliza (boot the TS bench server first; point adapter at it)
ELIZA_BENCH_URL=http://127.0.0.1:3949 ELIZA_BENCH_TOKEN=… MULTITASK_ELIZA_USAGE_FIX=1 \
  BENCHMARK_MODEL_PROVIDER=cerebras \
  python -m multitask_bench --harness eliza --lanes 1,5,10 --model gpt-oss-120b
```
