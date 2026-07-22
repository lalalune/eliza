# @elizaos/plugin-cli-inference

TOS-clean SAFE/CLOUD inference route for elizaOS. Serves chat/planner inference through sanctioned Claude/Codex CLI and SDK subprocesses. Ambient logins stay on disk; pooled auth is materialized by the account bridge into a least-privilege subprocess environment and is never written to the parent environment, persisted by this plugin, or logged.

## Purpose / role

This is the develop-shippable peer to the two TOS-gray, never-commit bypass paths:

- the in-process claude-code-stealth fetch interceptor at `packages/agent/src/auth/credentials.ts`, and
- `plugin-codex-cli`'s in-process `postResponses` HTTP path,

both of which replay the consumer-subscription token into a third-party HTTP client. Here the handlers use first-party CLI/SDK subprocesses. Ambient auth is loaded from `~/.claude` / `~/.codex`; pooled auth is restricted to the selected backend's canonical key (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_HOME`, or `OPENAI_API_KEY`). Every SDK child receives only the process-launch allowlist plus that backend's auth, and stderr is redacted before logging.

Node-only (`"platforms": ["node"]`) — exported from `index.node.ts` only.

## Enable

Single env gate: **`ELIZA_CHAT_VIA_CLI=claude`**, **`claude-sdk`**, **`codex`**, or **`codex-sdk`**.

- Unset → the plugin is never added to the resolved set (`auto-enable.ts shouldEnable` is false), and even if force-loaded its models map is empty. INERT; no existing code path changes.
- `claude` / `codex` → the large-tier handlers **cold-spawn** that CLI per call (`claude --print` / `codex exec`).
- `claude-sdk` → each handler runs an **isolated Claude Agent SDK query** with native planner tool-calling. The SDK has no history-reset API, so a query is never reused across Eliza model calls; this prevents hidden context from crossing rooms, users, or runtimes.
- `codex-sdk` → each handler constructs a request-owned SDK adapter and fresh Codex thread; response schemas use native structured output without retaining thread history.

## Plugin surface

No actions, providers, evaluators, or routes. Model handlers only, and **only the large tier** so high-frequency should-respond/triage calls fall through to the cheap configured provider (bounding per-turn spawn cost to a few ~3-4s calls):

| Model type | Backend |
|---|---|
| `TEXT_LARGE` | Configured Claude/Codex CLI or isolated SDK backend |
| `TEXT_MEGA` | "" |
| `RESPONSE_HANDLER` | "" |
| `ACTION_PLANNER` | "" — **only when `ELIZA_PLANNER_NATIVE_TOOLS=0`** (text-planner mode) |

`TEXT_SMALL` / `TEXT_NANO` / `TEXT_MEDIUM` are intentionally **not** registered (high-frequency triage tiers fall through to the cheap provider).

`ACTION_PLANNER` is **conditional**: in the default native-tools mode
(`ELIZA_PLANNER_NATIVE_TOOLS=1`) it is **not** registered, because that planner
needs GBNF / native-tool grammar the free-text CLI cannot honor — so the planner
stays on a grammar-honoring provider while the CLI still serves the user-facing
reply (`RESPONSE_HANDLER`) and large generations (`TEXT_LARGE`). In **text-planner
mode** (`ELIZA_PLANNER_NATIVE_TOOLS=0`) the CLI **does** register and serve
`ACTION_PLANNER`: the grammar-heavy planner prompt is rewritten into a clean
"pick ONE action, emit `{action, params}` JSON" routing prompt (see
`clean-routing-planner.ts`, proven live with `claude --print --model
claude-opus-4-8`). This is how the **whole brain** (chat + planner + coding) can
run on a single Claude Max subscription **TOS-clean**, no API key, no stealth.
Note: the per-turn `claude` subprocess makes the text-planner path slower than a
direct-API provider (~tens of seconds for a planner turn) — use the `claude-sdk`
backend below to keep the clean path fast.

## Isolated Claude Agent SDK backend (`ELIZA_CHAT_VIA_CLI=claude-sdk`)

The fast, TOS-clean way to run the whole brain on a Claude Max subscription.
Effective 2026-06-15 Anthropic grants subscriptions a monthly **Agent SDK
credit**, so driving the brain through `@anthropic-ai/claude-agent-sdk` (which
reads `~/.claude` or the account bridge's subprocess-scoped
`CLAUDE_CODE_OAUTH_TOKEN`) is **officially sanctioned**, strictly cleaner than the stealth
token-replay. The SDK is loaded via a variable dynamic import (`src/claude-sdk-session.ts`)
so the plugin stays inert and never imports it unless this backend is set.

The plugin constructs one `ClaudeSdkSession` per Eliza model call and disposes
its streaming-input `query()` after that call. Eliza already supplies the full
transcript, while the SDK query retains hidden conversation state and offers no
reset primitive; per-call ownership is therefore the security boundary. Three modes:

- **TEXT mode** (`generate`) — `RESPONSE_HANDLER` / `TEXT_LARGE` / `TEXT_MEGA`.
  `allowedTools: []` + `settingSources: []` strip Claude Code's own tools and
  project context → a pure chat-completion query. The model is reframed as a
  pure completion engine (`frameTextSystemPrompt` system prefix + a closing
  `appendTextDirective`) so it synthesizes the final reply from already-executed
  tool results rather than narrating agentic intent ("I'll fetch it…").
- **ROUTE mode** (`route`) — `ACTION_PLANNER` (text-planner mode). A single
  in-process MCP tool `route_action({action, params})` is the only allowed tool.
  The model emits a **native `tool_use`**; the SDK routes it to our handler
  in-process; the handler captures `{action, params}` and **eliza executes the
  action** (Claude Code never does). This matches the stealth/native path's full
  functionality (WEB_FETCH, sub-agents) with no free-text JSON parsing and no
  required-tool retry loop. The returned bare `{action, params}` is consumed by
  the loop's existing text-mode parser — no core change.
- **ENVELOPE mode** (`envelope`) — the Stage-1 `RESPONSE_HANDLER` captures the
  framework's composed `handle_response` tool fields natively. Calls without
  that tool remain text completions, so evaluator and failure-reply paths do not
  receive a routing envelope accidentally.

Account affinity is keyed by backend plus a hash of the runtime agent id and
core's `providerOptions.eliza.conversationId` (the chat room or planner trajectory),
but SDK query state is never cached. All SDK modes for the same supplied identity
share one pin and serialize so selection and rate-limit rotation cannot race;
calls without an identity receive a unique per-request key and never converge on
a global lock. The `result` envelope is inspected so an
`error_max_turns`/empty turn falls back to `result.result` instead of throwing a
spurious "empty completion". Stored affinity contains account identity only;
materialized OAuth tokens and `CODEX_HOME` environments live only for the call.

Per-tier models: `ELIZA_CLI_CLAUDE_PLANNER_MODEL` (small/planner, e.g. sonnet) +
`ELIZA_CLI_CLAUDE_MODEL` (large, e.g. opus); `ELIZA_CLI_CLAUDE_BIN` points the
SDK at the Claude Code executable.

**Caveat:** the monthly Agent SDK credit can run dry mid-month (the SDK then
returns a session-limit error); plan a fallback (a key/Cloud tier, or stealth on
a self-host) for production continuity.

## Isolated Codex SDK backend (`ELIZA_CHAT_VIA_CLI=codex-sdk`)

The codex peer of `claude-sdk` (`src/codex-sdk-session.ts`). Runs the brain on a
ChatGPT/Codex subscription via `@openai/codex-sdk` (loaded by variable dynamic
import; reads `~/.codex/auth.json` itself). A `CodexSdkSession` and its `Thread`
are both constructed fresh for every Eliza model call. Eliza
already sends the complete transcript, so retaining SDK thread context would
leak hidden history across rooms, users, and system prompts. Two modes:

- **TEXT** (`generate`): when a caller supplies `responseSchema`, normalize its
  nested objects to the Responses API's strict contract and call
  `thread.run(body, { outputSchema })` (plain `thread.run(body)` otherwise), with `sandboxMode:"read-only"`,
  `approvalPolicy:"never"`, `networkAccessEnabled:false`; returns the turn's
  `finalResponse`. Open maps and unconstrained values pass through a closed JSON
  string envelope and are restored before downstream validation, so dynamic keys
  are not silently erased.
- **ROUTE** (`route`): codex NATIVE structured output (`outputSchema`) constrains
  the turn to `{action, params}` (params as a JSON string for OpenAI strict mode),
  reliable at scale. `ELIZA_CLI_CODEX_BIN` optionally overrides the SDK's
  version-matched binary for deployments that manage Codex separately.

codex-sdk has no thread-level system prompt, so the system and complete
transcript are folded into the body of each isolated call. Per-tier models:
`ELIZA_CLI_CODEX_PLANNER_MODEL` + `ELIZA_CLI_CODEX_MODEL`;
`ELIZA_CLI_CODEX_REASONING_EFFORT` sets `modelReasoningEffort`. The session
always pins a transport-supported value (default `high`) so an ambient Codex
CLI setting such as `ultra` cannot become the unsupported Responses API value
`max`; explicit `max` / `ultra` aliases are normalized to `xhigh`. Fake-SDK tests
cover request isolation, strict-schema normalization/restoration, routing,
effort, and failure paths.

## Layout

```
plugins/plugin-cli-inference/
  index.ts                  Plugin entry — gates + registers large-tier handlers; init double-activation guard
  index.node.ts             Node re-export
  index.browser.ts          Browser stub (node-only plugin; empty models)
  auto-enable.ts            shouldEnable = ELIZA_CHAT_VIA_CLI is claude|claude-sdk|codex|codex-sdk
  src/
    claude-cli.ts           ClaudeCli — spawns `claude --print`; __setSpawnForTests seam
    codex-cli-exec.ts       CodexCli — spawns `codex exec --json`; JSONL last-assistant parse
    prompt-flatten.ts       system/developer -> system slot; user/assistant/tool -> body; nothing dropped
    sandbox.ts              SOC2 helpers copied from plugin-sub-agent-claude-code (filterEnv/resolveSafeCwd/resolveSafeBinary/SENSITIVE_ENV_RE)
  __tests__/
    cli-inference.test.ts   Unit tests (mock spawn): argv, token-absence, threading, parse, throw-on-error, large-tier-only
  build.ts  vitest.config.ts  tsconfig*.json  biome.json
```

## GenerateTextParams -> CLI mapping (HARD REQ: forward BOTH system AND messages/prompt)

- **claude:** `[claude, -p <flattened body>, --system-prompt <params.system FULL REPLACE>, --exclude-dynamic-system-prompt-sections, --output-format text, --model <ELIZA_CLI_CLAUDE_MODEL || claude-opus-4-8>]`, stdin `/dev/null`, cwd = isolated empty tmpdir, env = `filterEnv(process.env)`.
- **codex:** `[codex, exec, -m <ELIZA_CLI_CODEX_MODEL || gpt-5.5>, -s read-only, --skip-git-repo-check, -C <cwd>, --color never, --json, <system folded on top of flattened body>]`.

`prompt-flatten` re-routes system/developer roles to the system slot and flattens user/assistant/tool turns into the body; messages are NEVER dropped (would strip skills/memory/recent-convo/grammar).

## Config / env vars

| Var | Required | Default | Description |
|---|---|---|---|
| `ELIZA_CHAT_VIA_CLI` | — | (unset = inert) | `claude`, `claude-sdk`, `codex`, or `codex-sdk` — the single enable gate |
| `ELIZA_CLI_CLAUDE_MODEL` | No | `claude-opus-4-8` | claude large-tier model (`--model` / SDK large tier) |
| `ELIZA_CLI_CLAUDE_PLANNER_MODEL` | No | (falls back to large) | `claude-sdk` small/planner tier model (e.g. sonnet) |
| `ELIZA_CLI_CLAUDE_BIN` | No | (SDK default / allowlist lookup) | path to the claude executable: drives the `claude-sdk` session AND pins the cold `claude` spawn (deploys outside the SOC2 launcher allowlist) |
| `ELIZA_CLI_CLAUDE_EFFORT` | No | (SDK default: high) | `claude-sdk`: reasoning effort forwarded to the SDK `effort` option (`low`/`medium`/`high`/`xhigh`/`max`); an unsupported level for the model is silently downgraded by the SDK |
| `ELIZA_CLI_CLAUDE_PLANNER_EFFORT` | No | (falls back to `ELIZA_CLI_CLAUDE_EFFORT`) | `claude-sdk`: effort for the ROUTE-mode planner tier, so routing depth tunes independently of reply depth |
| `ELIZA_CLI_CLAUDE_ALL_TIERS` | No | (unset = large tiers only) | `claude-sdk`: also serve the high-frequency triage tiers (TEXT_SMALL/NANO/MEDIUM) on this route so the ENTIRE text brain runs on the one subscription (no cerebras/gemma fallthrough). Higher subscription usage; triage defaults to the cheaper large-tier model, not the planner tier |
| `ELIZA_CLI_CLAUDE_SMALL_MODEL` | No | (falls back to `ELIZA_CLI_CLAUDE_MODEL`) | `claude-sdk` ALL-TIERS: model for the triage tiers (should-respond gate, callback rewrite) — set a cheaper model (e.g. sonnet/haiku) so high-frequency triage doesn't run on opus |
| `ELIZA_CLI_CODEX_MODEL` | No | `gpt-5.5` | codex large-tier model (`codex exec -m` / SDK large tier) |
| `ELIZA_CLI_CODEX_PLANNER_MODEL` | No | (falls back to large) | `codex-sdk` small/planner tier model |
| `ELIZA_CLI_CODEX_REASONING_EFFORT` | No | `high` | `codex-sdk`: `modelReasoningEffort` (`minimal`, `low`, `medium`, `high`, `xhigh`; `max`/`ultra` normalize to `xhigh`) |
| `ELIZA_CLI_CODEX_BIN` | No | (SDK-pinned binary / allowlist lookup) | optional system codex override for `codex-sdk`; also pins the cold `codex` spawn |
| `ELIZA_CLI_SDK_TURN_TIMEOUT_MS` | No | `90000` | Claude SDK query/read timeout; explicit `0` opts into an unbounded turn |
| `ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION` | No | enabled | set to `0`/`false`/`no`/`off` to disable pooled SDK account rotation |
| `ELIZA_CLI_TIMEOUT_MS` | No | `120000` | per-call spawn timeout (SIGTERM on expiry; CLI backends) |

## Errors

Handlers THROW on non-zero exit / timeout (`+SIGTERM`) / empty stdout so `useModel` + AccountPool failover treat them as provider failures — never swallow-and-return-empty. stderr is redacted via `SENSITIVE_ENV_RE` before it reaches the error message or log.

## Commands

```bash
bun run --cwd plugins/plugin-cli-inference test       # vitest (mocks spawn; no real CLI)
bun run --cwd plugins/plugin-cli-inference typecheck
bun run --cwd plugins/plugin-cli-inference lint:check
bun run --cwd plugins/plugin-cli-inference build
```

## Conventions / gotchas

- **Node-only.** `index.browser.ts` is a stub; the real handlers use `node:child_process`.
- **Double-activation guard.** `ELIZA_CHAT_VIA_CLI=claude` + `ELIZA_ENABLE_CLAUDE_STEALTH` both set throws in `init()` (two colliding claude routes). The guard lives in THIS plugin because `credentials.ts` is skip-worktree on the live branch.
- **Isolated cwd per call.** Created with `mkdtemp` under `tmpdir()`, validated by `resolveSafeCwd`, removed in a `finally`. Keeps the CLI out of real projects (suppresses Claude Code repo-context identity).
- **`/dev/null` stdin is REQUIRED** — without it the CLI waits ~3s for stdin.
- **sandbox.ts is a copy.** Keep in sync with `packages/plugin-remote-manifest/src/sub-agent-claude-code/sandbox.ts` if `SENSITIVE_ENV_RE` / `SAFE_ENV_KEYS` change upstream.
- **Multi-account pool auth + rotation (SDK backends only).** The `claude-sdk` / `codex-sdk` chat brain consults the shared `CODING_AGENT_SELECTOR_BRIDGE_SYMBOL` bridge accessor from `@elizaos/core` (in `src/account-rotation.ts`) POOL-FIRST. Selection state is scoped to the live `AgentRuntime`, serialized per hashed conversation/turn affinity key, and pinned to the serving account; requests lacking that core identity get unique keys rather than a global fallback lane. Every isolated call re-resolves that exact account so an expiring Claude token or rotated `CODEX_HOME` generation is refreshed before spawn. On a subscription-limit throw it marks the serving account, selects the next healthy account, and retries a fresh SDK query before provider failover — see issue #11180. Empty pools fall back to a backend-specific ambient environment; neither ambient nor pooled SDK children inherit unrelated host secrets. Only rate-limit-class errors rotate; non-limit errors rethrow straight to failover. Default ON when a pool is present; opt out with `ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION=0`. The COLD `claude --print` / `codex exec` CLIs still own one on-disk cred set (pool auth is SDK-only; the bare-CLI shim is issue #11180 Gap B).
- See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM requirements.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
