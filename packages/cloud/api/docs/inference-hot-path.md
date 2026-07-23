# Inference hot path

Refs: #9899, #16917, and #16925.

## Contract

An admitted Cloudflare Worker token/model request must not query or mutate
Postgres, connect to Railway Redis, or wait for an accounting write before
dispatching the provider request. This contract covers `/v1/chat`,
`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`,
`/v1/generate-prompts`, app chat, public A2A/MCP chat, shared-agent model turns,
and the internal Eliza model turn used by a voice session.

Direct TTS, STT, and voice-clone requests are outside this contract. They are
metered media or stateful job endpoints with their own reservation and job-state
requirements; they are not token/model LLM dispatches.

Eliza onboarding/provisioning chat and promotion/SEO/social content generation
are separate control-plane workflows. They combine model calls with provisioning,
ownership, connector, or publication state and do not expose the public
text/embedding inference contract. They remain visible in the provider-dispatch
inventory as synchronous control-plane work; adding one of those call sites to a
covered inference route requires migrating it to this cache/lease boundary first.

The synchronous Worker path is:

1. Cloudflare-native ingress rate limit.
2. Cloudflare KV cache reads for authorization, model pricing, organization
   balance revision, affiliate attribution, and app policy as applicable.
3. A per-organization Durable Object call that serializes the exact endpoint
   rate decision.
4. A call to the same object that durably leases the estimated charge.
5. A final call that durably marks provider-dispatch intent immediately before
   the provider invocation.
6. Provider dispatch.

A warm billed request therefore makes three serial Durable Object calls before
the provider. Keeping rate, money, and dispatch-intent transitions explicit
makes the crash states independently testable. The repository benchmark measures
those calls in-process; it is a regression tripwire, not evidence of deployed
cross-isolate or regional network latency.

The provider response, including direct provider-error responses, is not delayed
by database accounting. Post-provider settlement, cache projection, analytics,
and payout delivery run under `executionCtx.waitUntil`. A Durable Object alarm
recovers an expired dispatched monetary lease if response-side settlement
disappears.

This contract applies to the listed token/model routes in the inference Worker.
Non-Worker tools and excluded media/job endpoints retain their synchronous
accounting contracts, but a covered Worker route must never fall back to that
path. Missing or unavailable cache state produces a retryable 503 and starts
asynchronous hydration; insufficient cached balance produces 402; a rate denial
produces 429.

## Why Railway Redis is not on this path

Railway Redis remains useful to services running inside Railway's private
network. A Cloudflare Worker would reach it across providers using a public TCP
connection, adding connection setup, latency, egress, and another availability
dependency to every model request.

The covered token/model routes therefore bypass the legacy Railway Redis
deployment guard. Their ingress limits use Cloudflare Rate Limiting bindings,
and exact organization limits use the same per-organization Durable Object that
owns monetary leases. General API and excluded media/job routes can continue
using Railway Redis without making it a prerequisite for an LLM request.

Routes that own this cache-only credential check also bypass the global Steward
session resolver. Otherwise a cookie-authenticated app-chat or prompt request
could query the authoritative session store before reaching the route's warming
decision even though its route implementation was cache-only.

Moving the entire inference control plane into Railway would change this
tradeoff. In that topology, Redis with atomic scripts could own exact counters
and short-lived leases. Mixing a Cloudflare Worker with Railway Redis is not the
selected production architecture.

## State ownership

| State | Synchronous owner | Durable/source-of-truth owner | Consistency |
| --- | --- | --- | --- |
| API-key and Steward-session authorization | Cloudflare KV proof plus per-org Durable Object | Postgres/Steward | Eventual positive projection; strongly ordered revision/revocation check at dispatch |
| Moderation decision | Cloudflare KV proof plus per-org Durable Object | Postgres | Eventual positive projection; strongly ordered deny/revision check at dispatch |
| Model pricing | Cloudflare KV | Pricing tables | Revisioned cache; cold requests warm and retry |
| Affiliate attribution | Cloudflare KV | Postgres | Immutable snapshot per admitted request |
| App policy | Cloudflare KV | Postgres | Immutable snapshot per admitted request |
| Organization balance hint | Cloudflare KV | Postgres | Revisioned, lower-only admission hint |
| Organization endpoint rate | Durable Object | Durable Object | Strongly ordered per organization |
| In-flight estimated spend | Durable Object | Durable Object | Strongly ordered per organization |
| Anonymous identity and quota | Durable Object | Postgres projection | Strongly ordered counters; async revisioned mirror |
| Token/model credits, transactions, and payouts | none before provider | Postgres | Written after provider; idempotent recovery |

Eventual consistency is acceptable for metadata and projections whose revision,
TTL, and invalidation rules are explicit. It is not acceptable for concurrent
rate increments or admission against in-flight spend. Those decisions are
serialized in a Durable Object instead of implemented as read-modify-write
operations in KV. Post-provider credit debits and external balance mutations
remain transactional in Postgres and publish monotonic cache revisions.

## Authorization and cold-cache behavior

`INFERENCE_AUTH_CACHE_ENABLED` selects a fail-closed authorization path for
covered Worker inference routes. A positive KV value is a versioned proof, not
the revocation authority. It contains the organization, user, and credential
identity plus their monotonic revisions. The per-organization Durable Object
compares that proof with its current authorization state in the final dispatch
transition. A stale KV grant therefore cannot invoke a provider after an
organization, user, moderation, API-key, or Steward-session revocation reaches
the object.

Lifecycle writers use fail-closed ordering. Restrictive transitions reach the
Durable Object before their database transaction commits; if the object is
unavailable, the database mutation rolls back. Permissive transitions publish
only after commit. KV deletion is cache hygiene and reduces retries, but is not
relied upon for revocation correctness.

API-key entries are keyed by the full SHA-256 credential hash. Steward JWTs are
signature, expiry, issuer, and tenant checked locally on every request and their
cache entries are keyed by the full signed-token fingerprint. A monotonic
per-user `inference_session_not_before` revision revokes all JWTs issued before
that boundary without an unbounded token-tombstone set. Wallet signatures remain
outside the cache-only Worker path because their timestamped proof cannot safely
be replayed as asynchronous hydration.

On a Worker cache miss:

- the request receives a retryable warming response;
- the authoritative lookup is registered with `waitUntil`;
- concurrent hydration is single-flight by identity; and
- no provider request starts until a later request observes the populated
  cache.

Cache errors never fabricate authorization and never join a Postgres fallback
to the request promise. The final provider-dispatch transition must acknowledge
the current authorization-boundary protocol version; an older or mixed-version
Durable Object response fails closed before the provider call.

Pricing, affiliate attribution, app policy, balance, and uninitialized Durable
Objects follow the same fail-closed warming pattern. The first request may warm
state; it does not purchase lower latency by bypassing a correctness check.

## Organization admission protocol

`InferenceAdmissionGate` is addressed by organization ID. A lease request
contains:

- request and organization identity;
- the cached balance and monotonic balance revision;
- an estimated charge; and
- a versioned recovery snapshot that pins the only allowed accounting lane.

The object durably:

1. applies only safe balance revisions;
2. subtracts all active and expired monetary holds;
3. rejects an unaffordable request;
4. stores the lease and its recovery snapshot before replying;
5. persists provider-dispatch intent immediately before invocation; and
6. schedules recovery atomically with every persisted active-lease state.

Duplicate request IDs are idempotent only when their immutable lease facts
match. A higher but stale balance hint cannot restore capacity. An expired lease
that was never dispatched releases its hold. An expired dispatched lease is
claimed for recovery and retains its hold until the pinned accounting lane
finishes. The exact object lease replaces the KV optimistic lane's minimum
balance cushion: an organization below that compatibility threshold is admitted
whenever its cached balance can cover this request, including exact equality.

After provider work, exactly one lane settles the lease:

- **organization credits:** deterministic direct debit keyed by organization
  and request;
- **affiliate inference:** atomic direct debit plus payout-outbox insertion,
  using the pinned affiliate and payout identity; or
- **monetized app:** server-generated app reservation using the same estimate
  and request identity, followed by reconciliation to actual usage.

The response-side task debits/reconciles Postgres, refreshes projections, and
then tells the Durable Object the balance-backed amount, conservative
gate-consumed amount, and authoritative post-accounting balance revision. If
that task is lost, the alarm replays the same idempotent lane at the conservative
estimate. The object clears a dispatched lease only with request-specific
proof. Any uncollected amount remains gate debt and cannot be resurrected by a
delayed balance snapshot.

There is no pre-provider database ledger insert, KV pending-charge write, or
background reservation. The durable lease itself is the write-ahead record.
This avoids switching accounting identities between normal settlement and
recovery, which could otherwise double charge a request after an ambiguous
acknowledgement.

## Anonymous chat

Anonymous chat uses a separate Durable Object keyed by a hash of the opaque
session token. It owns session expiry, moderation state, lifetime quota, hourly
quota, active leases, and idempotent commit/refund.

A cold object returns 503 while Postgres state hydrates under `waitUntil`.
Admitted and refunded counter snapshots mirror to Postgres asynchronously with
monotonic revisions. The Durable Object remains authoritative for live quota,
so a delayed projection cannot grant extra messages.

## Failure semantics

- Missing/invalid cache or binding: 503; never synchronous SQL fallback.
- Cold cache or Durable Object: 503 plus asynchronous hydration.
- Cached or exact insufficient balance: 402 before provider dispatch.
- Exact endpoint or ingress limit: 429 before provider dispatch.
- Provider failure known to be uncharged: release/reconcile with zero according
  to the route's provider-outcome classifier.
- Ambiguous or billable provider outcome: conservatively settle.
- Accounting failure after provider: keep the lease, invalidate permissive
  balance projections, and retry through the same idempotent identity.
- Expired undispatched lease: release the hold without charging.
- Expired dispatched or recovering lease: keep the hold until alarm recovery
  returns an authoritative balance revision.

These rules prefer an explicit retry over hidden latency or free inference.

## Deployment configuration

Staging and production require:

- `CACHE_KV`;
- `CACHE_BACKEND="kv"`;
- `GLOBAL_RATE_LIMITER`, `CHAT_ROUTE_RATE_LIMITER`, and
  `DASHBOARD_CHAT_ROUTE_RATE_LIMITER`;
- `INFERENCE_ADMISSION_GATES`;
- `ANONYMOUS_CHAT_GATES`;
- `INFERENCE_OPTIMISTIC_BILLING="true"`;
- `INFERENCE_DEFERRED_ADMISSION="true"`; and
- `INFERENCE_HOT_PATH_CACHES="true"`;
- `INFERENCE_AUTH_CACHE_ENABLED="true"`.

The deploy workflow applies database migrations before publishing the Worker.
That ordering is required because the authorization proof reads monotonic
revision columns installed by the same release. If migration fails, the Worker
deploy is skipped. Rolling the authorization flag back to `"false"` restores
the authoritative compatibility path, but covered inference routes must not be
left in a mixed mode that silently falls through from KV to Railway Redis.

`INFERENCE_BILLING_LEDGER` still selects the compatibility ledger for
non-Worker callers and sweep migration support. It does not add a ledger write
before provider dispatch on the Worker path.

`REDIS_RATE_LIMITING` continues to govern general API routes. The covered
token/model routes use Cloudflare-native bindings and do not require
`REDIS_URL`.

## Verification

The production contract is protected at three layers:

1. A source inventory discovers provider dispatch sites and requires every
   covered user-triggered LLM path to declare its admission contract. Route
   tripwire tests install database seams that throw if chat, completions,
   messages, responses, embeddings, prompt generation, app/A2A/MCP chat,
   shared-agent, the covered connector shared-model dispatch segment, or the
   voice-session internal Eliza turn touches them before provider dispatch.
2. Admission tests assert the only warm pre-dispatch write is the Durable
   Object lease, including organization, affiliate, app, anonymous, cold-cache,
   concurrency, and crash-recovery cases.
3. An in-process benchmark measures the serial rate, lease, authorization
   re-check, and dispatch transitions and asserts zero pre-provider Postgres,
   Redis, ledger, reservation, or payout operations. It reports latency without
   imposing host-speed floors. Deployed Worker-to-Durable-Object latency must be
   measured separately in the target Cloudflare topology.

Migration tests apply the accounting schema to PGlite. Money tests exercise
idempotent direct debits, app reconciliation, affiliate payout outbox replay,
alarm-versus-late-settlement races, and monotonic balance revisions.
