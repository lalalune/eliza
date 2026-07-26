# Giraffe agentic parent suite: capability audit and implementation plan

**Status:** research and implementation proposal  
**Date:** 2026-07-26  
**Input reviewed:** `Giraffe_Design_Brief_v2.pdf`, all nine pages, including a
rendered visual review  
**Product boundary:** extend LifeOps through the existing elizaOS runtime,
calendar, scheduling, approval, entity, connector, and scenario infrastructure.
Do not create a second scheduler, a second household graph, persona-specific
runtime rails, or behavior inferred from prompt text.

## Executive conclusion

The Giraffe brief is directionally right, but it describes a product that is
much more than an LLM with calendar access. The LLM can already do a meaningful
part of the work:

- interpret a rambling voice note;
- extract tentative dates, people, places, constraints, and action items;
- summarize source material;
- rank options;
- draft a concise factual message;
- propose meals, gifts, activities, and trade-off scenarios; and
- explain why a recommendation was made.

The LLM cannot implicitly guarantee that every authoritative source was read,
that the right child or calendar was selected, that another adult consented,
that a private event was not exposed, that a later change was detected, that a
purchase happened exactly once, or that an obligation was completed. Those
properties require deterministic platform primitives.

The recommended product contract is:

> Giraffe owns Conception and Planning wherever it has reliable evidence. It
> executes reversible, low-risk work within an explicit policy, and hands
> consequential decisions, sends, purchases, custody changes, medical matters,
> and financial commitments to the correct human for approval.

This is how the product actually reduces mental load. Research on household
cognitive labor separates anticipating needs, identifying options, deciding,
and monitoring outcomes; mothers disproportionately carry anticipation and
monitoring, not merely visible execution
([peer-reviewed study](https://pmc.ncbi.nlm.nih.gov/articles/PMC11761833/),
[household-management study](https://pmc.ncbi.nlm.nih.gov/articles/PMC8223758/)).
An assistant that waits for a parent to notice, formulate, delegate, and verify
every task is a faster secretary, not relief from the mental load.

elizaOS already has much of the orchestration substrate:

- one durable, structural scheduled-task runner;
- multi-account Google and native Apple calendar aggregation;
- calendar CRUD, recurrence, reminders, travel buffers, and owner-feed conflict
  scans;
- entity and relationship stores;
- approval tasks and conservative no-reply behavior;
- Gmail, iMessage, WhatsApp, Telegram, Signal, Discord, Twilio, Calendly, and
  Duffel connectors;
- finance, reminders, goals, documents, inbox, contacts, and travel domains;
- bidirectional voice infrastructure; and
- a serious scenario runner with live-model trajectories and artifact checks.

However, the existing product is not yet Giraffe. The major gaps are
authoritative household ingestion, guest free/busy, family roles and scoped
access, schedule proposals versus agreements, dependency-aware conflict
detection, append-only shared records, school and community sources, meal/cart
execution, inventory confidence, seasonal opportunity tracking, and
evidence-backed safety policies. A realistic estimate is roughly 70% of the
generic orchestration substrate but only 25-35% of the parent-domain product.

The first implementation milestone should not be “all nine categories.” It
should be one trusted loop for a world-traveling co-parent:

1. ingest the family’s real sources;
2. identify a material schedule impact before it becomes urgent;
3. propose a coverage plan without leaking private details;
4. obtain approvals from affected adults;
5. monitor source changes;
6. recompute and re-approve material changes; and
7. verify closure.

That loop proves the difficult shared primitives that every later category
needs.

## 1. Reading the brief as product requirements

### 1.1 What the brief gets right

The strongest ideas in the brief should become acceptance criteria:

1. **No IT-administrator tax.** Import existing calendars, messages, documents,
   contacts, orders, and preferences. Do not ask a depleted parent to build a
   household database before receiving value.
2. **Do not entrench the default parent.** Information, responsibility,
   reminders, and follow-up must route to the actual owner, not boomerang to
   Mom whenever someone else does not act.
3. **Support human connection.** Parenting and emotional guidance must help the
   user involve partners, friends, doctors, schools, or professionals rather
   than imitate a confidant.
4. **A reminder must lead to action.** A due date needs the responsible person,
   contact, source, link, location, prerequisites, and next safe action.
5. **Cross-household communication stays factual and approved.** Observation -
   Need - Request is a useful draft structure. Giraffe must not invent a
   feeling, motive, diagnosis, legal conclusion, or concession.
6. **Shared records survive scrutiny.** Proposed and confirmed schedule changes
   must be distinguishable, versioned, exportable, and scoped to the people who
   should see them.
7. **Conception matters more than clerical execution.** The system should notice
   a summer-camp deadline, low-stock staple, schedule collision, or missing
   caregiver before the parent has already done the hard cognitive work.

### 1.2 Where the brief is underspecified

The brief needs explicit answers to these questions before implementation:

- Which source is authoritative when a school PDF, email, portal, and calendar
  disagree?
- Is a calendar entry informational, proposed, accepted, or mandated?
- Who may see free/busy versus event details?
- Which household member owns Conception, Planning, Execution, and Monitoring?
- What happens when the assigned adult never opens the app?
- What constitutes a material change that invalidates prior approval?
- How fresh must each connector be before the system may say a slot is free?
- What exactly can a nanny, grandparent, current partner, former partner, child,
  mediator, or lawyer see?
- How are recurring custody schedules, holiday exceptions, daylight saving
  changes, and international date-line travel reconciled?
- Which writes are reversible? Which require approval? Which require approval
  from more than one adult?
- How does a purchase retry without creating a duplicate order?
- What evidence proves that the task or transaction completed?
- What happens when a connector is revoked, stale, partially synchronized, or
  rate-limited?

These are not prompt-writing details. They are domain contracts.

## 2. Capability maturity model

Every feature claim should state its maturity level. This prevents a fluent
model response from being mistaken for delegation.

| Level | Name | Product meaning | Example |
| --- | --- | --- | --- |
| L0 | Prose | Advice or draft only; no durable state | Suggest three dinners |
| L1 | Capture | Proposed structured state with source and confidence | Extract a school event from a PDF |
| L2 | Coordinate | Resolve dependencies, conflicts, owners, visibility, and consent | Propose custody-swap coverage |
| L3 | Transact | Perform an approved, idempotent external action and retain its receipt | Build and submit a grocery order |
| L4 | Monitor and close | Observe changes and outcome, recover from failure, and verify completion | Recompute coverage after a flight delay |

The Phase 1 bar should be L4 for calendar/travel coordination, L2-L3 for school
ingestion and messaging, and L2 for external recommendations. A meal suggestion
is L0. A generated Instacart link is at most L2. An approved order with status,
substitution handling, and refund recovery is L3-L4.

## 3. What exists in elizaOS today

### 3.1 Scheduling spine: strong and reusable

`@elizaos/plugin-scheduling` is the correct foundation. It is already loaded
across platforms and provides:

- `cron`, `interval`, `once`, `event`, `after_task`,
  `relative_to_anchor`, and `during_window` triggers;
- task kinds for reminders, check-ins, follow-ups, watchers, approvals, recaps,
  and outputs;
- gates, completion checks, escalation ladders, quiet-hour behavior,
  consolidation, retry/backoff, and connector degradation;
- durable SQL persistence with an in-memory fallback;
- atomic claims and idempotency;
- REST routes and task-state logs; and
- structural behavior that never pattern-matches `promptInstructions`.

Giraffe must contribute new task definitions, gates, completion checks, event
families, anchors, and pipelines to this runner. It must not add a “Giraffe
scheduler.”

### 3.2 Calendar: substantial, but not yet a family scheduling engine

`@elizaos/plugin-calendar` already:

- lists readable Google calendars across connector grants;
- aggregates selected calendars across multiple Google accounts and native
  Apple Calendar;
- preserves provider, side, account, calendar, grant, attendee, organizer,
  recurrence, time-zone, conference, and sync metadata;
- reads feeds and next-event context;
- searches, creates, updates, and deletes events;
- handles Google recurrence and event attendees;
- maintains calendar inclusion preferences;
- creates reminder plans and audit events; and
- supports travel-window and travel-buffer behavior.

Relevant implementation entry points include:

- `plugins/plugin-calendar/src/service/CalendarService.ts:201` for feed merging;
- `CalendarService.ts:344` for calendar enumeration;
- `CalendarService.ts:688` for aggregate feed reads;
- `CalendarService.ts:835`, `:951`, and `:1130` for event CRUD; and
- `plugins/plugin-google/src/calendar.ts:24-175` for provider calls.

This is enough to unify calendars the owner can already access. A Google shared
calendar or subscribed calendar is visible when the connected account has
reader access. It is not enough to inspect a guest’s private calendar without a
grant, infer consent, or negotiate cross-household schedule changes.

The current synchronization path is also a feed cache, not yet a durable
provider-reconciliation loop:

- Google event reads use a bounded requested window rather than incremental
  `syncToken` state;
- pagination is not consumed end to end;
- provider watch/webhook channels are not registered;
- provider cancellations are not preserved as first-class change records; and
- a stored window timestamp does not prove that no provider changes were
  missed.

Google exposes pagination, incremental sync tokens, controlled full resync after
token invalidation, and push notifications
([incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync),
[push notifications](https://developers.google.com/workspace/calendar/api/guides/push)).
Those mechanisms are required for Giraffe’s promise to notice school, travel,
and co-parent changes.

Apple support is materially narrower than Google in the current bridge. The
service rejects common invited-meeting mutations and recurring-event
create/update/delete paths, even though EventKit itself supports recurrence and
calendar-store change notifications. The calendar capability model must expose
the actual provider/permission capability instead of inferring behavior from
the provider name.

### 3.3 Conflict detection: useful, incomplete, and currently split

LifeOps has a real owner-feed overlap scanner in
`plugins/plugin-personal-assistant/src/actions/conflict-detect.ts`. It can scan
today, the next week, or a proposed event. It correctly fails when the calendar
source is unavailable instead of reporting a false “no conflicts.”

The important gap is visible in the loader contract:

- attendee free/busy is optional;
- its default implementation returns an empty list; and
- production wiring injects only the owner calendar feed.

Therefore a proposal may be checked against the owner’s selected calendars, but
not truly against a co-parent, caregiver, guest, room, or resource calendar.

There is also a second `CONFLICT_DETECT` action in
`plugins/plugin-calendar/src/actions/conflict-detect.ts` that explicitly
returns scaffold failures. The capability should have one canonical owner.
Before Giraffe builds on it, consolidate the implementation in the calendar
domain and remove or replace the scaffold registration.

Current conflict semantics are also too shallow for families. They are based on
time overlap and shared attendees. Giraffe needs conflict kinds for custody,
caregiver coverage, school pickup, travel time, vehicle/car seat, child age,
sibling incompatibility, preparation deadlines, recovery/rest, accessibility,
and private-busy constraints.

### 3.4 Scheduling negotiation: a good state machine with an unsafe send boundary

LifeOps already stores scheduling negotiations and proposals:

- negotiation subject, relationship, duration, time zone, state, accepted
  proposal, and metadata;
- proposal start/end, proposer, and status; and
- start, propose, respond, finalize, cancel, and list operations.

This is valuable substrate, but
`plugins/plugin-personal-assistant/src/lifeops/domains/scheduling-service.ts`
currently dispatches messages during `startNegotiation`, `proposeTime`,
`finalizeNegotiation`, and `cancelNegotiation`. That violates the Giraffe
brief’s mandatory human-approved-send rule for co-parents and schools.

The scheduling domain should produce a typed outbound draft or approval task.
Only the owner-send policy should dispatch it after approval. A scheduling
state transition and an external send must be separately auditable operations.

The negotiation also needs:

- candidate-slot derivation from real availability;
- constraints and ranked explanations;
- proposal expiry;
- per-party acceptance, not one global status;
- material-change invalidation;
- counterproposals;
- idempotent ingestion of inbound responses;
- a final calendar write after agreement;
- and explicit distinction between a court/parenting-plan baseline and a
  voluntary exception.

### 3.5 Connectors and adjacent domains

LifeOps currently registers Google, Telegram, Discord, Signal, WhatsApp,
iMessage, X, Twilio, Calendly, and Duffel. Google supplies Gmail and Calendar;
Apple Calendar is available through the native bridge. Calendly supplies
scheduled-event, event-type, availability, booking-link, and cancellation
capabilities. Duffel supports flight search and approval-gated booking.

Related product substrate includes:

- contacts and relationship edges such as `co_parent_of`;
- Gmail triage and drafts;
- documents and Drive;
- reminders, todos, goals, routines, and work threads;
- finance transactions, recurring charges, and bill data;
- approval tasks and conservative no-reply defaults;
- voice capture and entity/relationship observation; and
- the generic browser, web fetch, and web search capabilities.

Missing first-class connectors include Microsoft Outlook/Exchange Calendar,
CalDAV/webcal, school/SIS portals, community event sources, typed weather,
maps/travel-time as a domain source, grocery/cart/order providers, retailer
receipts, and household inventory devices.

### 3.6 Persona and scenario coverage

The requested persona does not exist as one coherent persona. Current coverage
is fragmented across:

- **Maya Reed:** two-kid working parent with dense family logistics;
- **Jordan Ellis:** separated co-parent, factual wording, expense splits, and
  child privacy;
- **Nora Klein:** frequent-flying consultant;
- **Elena:** calendar- and inbox-heavy business owner; and
- the separate frequent-traveler time-zone corpus.

The right response is a composite test persona, not a product mode. The LifeOps
architecture explicitly defines persona differences as owner facts plus
structural scheduling knobs through one runner.

Documentation is stale relative to the scenario corpus. The MVP document calls
J1 planned, but `co-parenting.catalog.json` now contains ten authored scenarios.
All ten remain `authored`, not live-verified. Existing J1 scenarios cover:

- recurring custody rhythm;
- exchange reminders;
- factual swap drafts;
- school-pickup conflicts;
- expense splits;
- a child-privacy firebreak;
- vent/blame boundaries; and
- no external send before approval.

The frequent-traveler corpus is stronger, including absolute versus wall-clock
semantics, ambiguous time zones, re-anchoring, lighter pre-trip load,
biological-night conflicts, messy itineraries, and time-zone history. The
missing proof is a composite, live, real-connector family journey.

## 4. Implicit LLM work versus explicit primitives

| Product task | LLM can do | Required deterministic capability |
| --- | --- | --- |
| Voice dump | Transcribe, segment, extract candidates | Speaker/account authorization, provenance, confirmation policy, durable writes |
| School calendar | Parse email/PDF/photo/ICS | Source registry, authoritative-version rules, dedupe, incremental sync, cancellation propagation |
| Find a time | Understand preferences and explain trade-offs | Free/busy, temporal normalization, constraints, solver, stale-source policy |
| Co-parent message | Draft Observation - Need - Request | Fact grounding, privacy filter, typed approval, exact sent-version audit |
| Local activities | Search and summarize | Source adapters, eligibility, dedupe, ranking constraints, freshness, saved decisions |
| Weather clothing | Explain forecast in family language | Typed forecast, location/time horizon, clothing policy, child preferences |
| Meal plan | Generate recipes and substitutions | Allergy/diet rules, household headcount, inventory confidence, price/availability, food-safety policy |
| Grocery order | Map ingredients to products | Retailer identity, cart, substitutions, approval, idempotency, receipt, order/refund status |
| Inventory | Infer likely depletion | Item identity, observations, confidence, consumption/order history, thresholds |
| Seasonal planning | Suggest what is usually timely | Household almanac, local deadlines, source provenance, watcher, completion |
| Financial model | Explain options and sensitivity | Versioned assumptions, tax/benefit inputs, formulas, ranges, missing-data validation |
| Parenting guidance | Explain a selected framework | Vetted corpus, citation/provenance, risk classifier, human/professional handoff |
| Overstimulation | Offer a check-in | Consent, local signals, privacy, false-positive controls, no ambient mood surveillance |
| Audit/export | Summarize a record | Append-only revisions, identities, timestamps, hashes, scope, retention, export integrity |

The model may propose inputs to these primitives. It must not substitute prose
for them.

## 5. Scheduling and calendar design

### 5.1 Calendar source registry

Add a provider-neutral calendar-source record, backed by the existing connector
grant model rather than a new credential store:

```ts
interface CalendarSource {
  id: string;
  householdId: string;
  connectorGrantId: string | null;
  provider: "google" | "apple" | "microsoft" | "caldav" | "ics" | "school";
  externalCalendarId: string;
  label: string;
  authority: "informational" | "household" | "school" | "custody_baseline";
  visibility: "details" | "free_busy" | "private_busy";
  writable: boolean;
  selected: boolean;
  timezone: string | null;
  lastSuccessfulSyncAt: string | null;
  syncState: "healthy" | "stale" | "revoked" | "error";
  sourceVersion: string | null;
}
```

Do not duplicate the calendar event store. Extend the calendar plugin’s source
and provenance contracts and preserve provider-specific metadata there.

Required behavior:

- every read states which sources were included, excluded, stale, or failed;
- a partial feed never becomes a confident “free” answer;
- free/busy does not reveal event titles;
- source authority is explicit;
- imported documents retain a source snapshot or stable reference;
- recurring events preserve series identity and exceptions;
- event cancellations propagate;
- all-day dates remain dates, not accidental UTC-midnight meetings; and
- calendar selection is user-visible and reversible.

### 5.2 “Looking at a guest calendar”

There is no ethical or technical shortcut for reading a guest’s calendar.
Giraffe should support four explicit paths:

1. **Shared calendar grant.** The guest shares a Google, Microsoft, Apple, or
   CalDAV calendar with the connected account. Giraffe reads only the granted
   visibility.
2. **Free/busy grant.** The guest authorizes free/busy only. Giraffe receives
   busy intervals without titles or descriptions. Google supports a
   `freeBusy.query` operation and a `freeBusyReader` ACL role
   ([Google free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query),
   [Google sharing roles](https://developers.google.com/workspace/calendar/api/concepts/sharing)).
3. **Availability request.** Giraffe sends an owner-approved request or
   scheduling link. The guest selects acceptable slots without connecting a
   calendar.
4. **Published ICS/webcal.** The guest or organization supplies a read-only
   calendar URL. Treat it as informational unless an agreement workflow says
   otherwise.

Never scrape a private calendar, infer permission from an email address, or ask
one parent to supply another adult’s password. A guest’s denial or revoked
grant is a valid outcome.

“Guest access” to the family record is a different primitive. A caregiver needs
a scoped, expiring role, not a calendar OAuth token:

```ts
interface HouseholdAccessGrant {
  householdId: string;
  principalId: string;
  role: "parent" | "co_parent" | "partner" | "caregiver" | "child" | "professional";
  scopes: string[];
  childIds: string[];
  startsAt: string | null;
  expiresAt: string | null;
  grantedBy: string;
  revokedAt: string | null;
}
```

A grandmother covering a trip may need the pickup schedule, emergency contacts,
allergy instructions, and authorized-pickup document. She does not need the
co-parent thread, work-calendar titles, household finances, private reflections,
or continuous location.

### 5.3 Availability and conflict engine

Implement a deterministic availability engine in `plugin-calendar`, consumed
by LifeOps. The engine should accept:

- people and resources;
- a time range;
- duration;
- hard and soft constraints;
- source freshness requirements;
- travel locations and modes;
- home and active travel time zones;
- custody/household context;
- preparation and recovery buffers; and
- visibility policy.

Return ranked slots with machine-readable reasons:

```ts
interface AvailabilityCandidate {
  startAt: string;
  endAt: string;
  score: number;
  satisfiedConstraintIds: string[];
  violatedSoftConstraintIds: string[];
  blockingConflictIds: string[];
  sourceFreshness: Record<string, string>;
  explanationFacts: string[];
}
```

Conflict kinds should include:

- direct overlap;
- insufficient travel time;
- custody or household-authority mismatch;
- missing caregiver or pickup coverage;
- caregiver not accepted or access expired;
- vehicle, car-seat, public-transit, or accessibility constraint;
- sibling or age incompatibility;
- preparation/deadline dependency;
- meal, sleep, recovery, or quiet-window collision;
- private-busy collision;
- source stale or unavailable;
- pending proposal already occupying the resource; and
- duplicate or contradictory source records.

Google free/busy supports up to 50 calendars per query and returns per-calendar
errors, which must remain visible rather than being flattened to empty
availability. Microsoft Graph offers `getSchedule` for free/busy and
`findMeetingTimes` for delegated work/school accounts
([Graph getSchedule](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0),
[Graph findMeetingTimes](https://learn.microsoft.com/en-us/graph/api/user-findmeetingtimes?view=graph-rest-1.0)).
Use provider free/busy as evidence, but keep ranking and family constraints in
the elizaOS engine so provider behavior is consistent and testable.

### 5.4 Proposal is not agreement

Introduce a schedule-change proposal that points to, but does not silently
overwrite, calendar events:

```ts
interface ScheduleChangeProposal {
  id: string;
  householdId: string;
  baselineEventIds: string[];
  proposedEvents: ProposedEvent[];
  reasonFacts: SourceFactRef[];
  affectedPrincipalIds: string[];
  requiredApprovalPrincipalIds: string[];
  approvalStates: Record<string, "pending" | "accepted" | "declined" | "expired">;
  status: "draft" | "proposed" | "accepted" | "declined" | "superseded" | "cancelled";
  materialityHash: string;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}
```

Rules:

- a co-parent adding an event does not prove the other parent agreed;
- a custody baseline is not overwritten by an informal exception;
- every affected adult sees the minimum facts needed to decide;
- event titles from private calendars are never included in the proposal;
- any material change after approval invalidates the affected approvals;
- simultaneous conflicting proposals are resolved explicitly, not last-write
  wins;
- accepted proposals create/update calendar records exactly once; and
- the baseline, proposal, approvals, sent messages, and resulting event changes
  are linked in the audit log.

### 5.5 Provider-neutral calendar port

Make provider capabilities explicit behind a calendar-owned port:

```ts
interface CalendarProviderPort {
  listCalendars(...args: unknown[]): Promise<unknown>;
  listEvents(...args: unknown[]): Promise<unknown>;
  getEvent(...args: unknown[]): Promise<unknown>;
  createEvent(...args: unknown[]): Promise<unknown>;
  updateEvent(...args: unknown[]): Promise<unknown>;
  cancelEvent(...args: unknown[]): Promise<unknown>;
  deletePrivateCopy(...args: unknown[]): Promise<unknown>;
  listInstances(...args: unknown[]): Promise<unknown>;
  queryFreeBusy(...args: unknown[]): Promise<unknown>;
  listPermissions(...args: unknown[]): Promise<unknown>;
  syncChanges(...args: unknown[]): Promise<unknown>;
  watchChanges(...args: unknown[]): Promise<unknown>;
  respondToInvitation(...args: unknown[]): Promise<unknown>;
  supports(capability: CalendarProviderCapability): boolean;
}
```

The illustrative signatures above need concrete DTOs during design; the
important contract is that create, invite, cancel, delete-my-copy, and decline
are separate operations.

Normalize these permission/capability facts:

- read details;
- read free/busy only;
- create;
- edit owned events;
- edit shared events;
- manage attendees;
- send updates;
- respond to invitation;
- enumerate instances;
- mutate one occurrence;
- mutate this-and-following;
- watch changes; and
- incremental sync.

Do not silently fall back from a read-only family or school calendar to the
owner’s primary calendar. An attempted write to a read-only source must fail
with an actionable choice.

Google event mutations need an explicit attendee-notification policy.
`sendUpdates` behavior is provider-specific; a calendar event containing
attendees does not prove invitations or updates were delivered
([Google event insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)).
Before approval, show the consequence: “This will notify four attendees.”
After execution, retain the provider result and notification intent.

### 5.6 Time zones, recurrence, and travel

Store absolute instants for travel and meetings, local dates for all-day
events, and the intended IANA time zone for wall-clock recurrence. Never infer
one representation from another without recording the decision.

Required cases:

- a flight remains the same instant when the user changes device time zone;
- a Friday 4:30 PM custody exchange follows the intended local household time;
- recurring events survive daylight saving transitions;
- international date-line crossing does not duplicate or skip a handoff;
- “Tuesday at 9” is clarified when the user is traveling and no zone is
  authoritative;
- door-to-door absence includes airport transfer, check-in, immigration,
  delays, and recovery—not just flight times; and
- notification quiet hours distinguish home-family urgency from destination
  local time.

Family recurrence requires more than Google instance/series CRUD:

- alternating-week custody baseline;
- dated swaps and makeup-time links;
- holiday and school-break precedence;
- odd/even-year allocation;
- one occurrence, whole series, and this-and-following;
- safe series splitting;
- preservation or explicit loss of later exceptions; and
- provider notification consequences.

Google’s documented this-and-following workflow trims the original series and
creates a new series, with consequences for later exceptions
([Google recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents)).
The deterministic calendar layer must perform and verify that transformation;
the LLM should only interpret the user’s intended scope.

Current conflict behavior also needs normalization:

- `scan_today` must use the owner/household local day, not UTC boundaries;
- canceled, declined, tentative, transparent/free, private, out-of-office,
  working-elsewhere, and all-day events need one cross-provider policy;
- an all-day “school closed” event may not block every minute, but it creates a
  childcare constraint;
- event/resource version or ETag must protect concurrent writes; and
- source failure yields `unknown`, never “free.”

### 5.7 Scheduling connectors: priority order

**P0 - complete and harden existing paths**

- Google Calendar: free/busy, incremental sync/watch channels, ACL/visibility,
  pagination, controlled resync, attendee response state, explicit
  create/update/cancel notification policy, optimistic concurrency, event
  change provenance, and per-calendar sync health.
- Apple EventKit: source visibility, store-change notifications, and clear
  provider limitations. Apple requires user-granted calendar access; current
  EventKit offers write-only or full access rather than a general read-only
  grant
  ([Apple EventKit access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)).
- Calendly: availability and single-use links as an explicit guest handoff.
- Maps/travel time: make the existing map calculation a typed dependency with
  freshness, mode, and “unavailable” semantics.

**P1 - fill common family-source gaps**

- Microsoft Graph/Outlook Calendar for work and school accounts;
- ICS/webcal with SSRF protection, ETag/Last-Modified, recurrence, cancellation,
  and change history;
- Gmail/Drive/document ingestion for school notices and itinerary changes;
- school portal/SIS adapters where stable APIs exist, with browser automation
  only as an explicit, observable fallback; and
- team/activity calendar imports.

**P2 - broaden interoperability**

- CalDAV for non-Google/non-Microsoft calendars;
- co-parenting platform export/import or approved APIs;
- caregiver availability links;
- room/resource calendars; and
- airline/hotel/ground-transport change feeds beyond email parsing.

## 6. Human workflow findings and product implications

### 6.1 Shared calendars do not distribute responsibility by themselves

Parents commonly combine a shared calendar, a wall display, a weekly planning
conversation, meal plans, and ad hoc messages. The repeated failure is
inconsistent capture and one person becoming the calendar’s unpaid operator.
One first-person account describes finally making the other parent consult the
shared record instead of interrupting her for facts; the improvement came when
he added his own travel and began maintaining his own reminders
([working-parent account](https://www.reddit.com/r/workingmoms/comments/1qxh7dt/i_stopped_being_the_family_calendar/)).
Other parents describe the deeper problem as “why is this my list?”: entering
and assigning work to another adult still leaves Conception and Monitoring with
the list-maker
([WorkingMoms discussion](https://www.reddit.com/r/workingmoms/comments/1gblj3r)).
Families also report that both adults forget to enter events and that syncing
the calendars they already use is more valuable than another manual-entry
surface
([family calendar discussion](https://www.reddit.com/r/family/comments/1s4562g/digital_calendar_for_family_with_sports_school/)).

Product implications:

- create one canonical record with several delivery surfaces;
- give every obligation an owner and completion evidence;
- detect a member who never reads or acts, then initiate a private,
  non-shaming renegotiation;
- never redirect all failed assignments to the default parent;
- produce a concise weekly household brief that supports a human conversation;
- measure who owns Conception, Planning, Execution, and Monitoring;
- allow an agreed Minimum Standard of Care; and
- infer and suggest ownership gradually instead of requiring a 100-card setup.

### 6.2 Travel creates a coverage project, not a calendar block

Families often prepare one or two weeks ahead of business travel, align meals
and routines, recruit relatives or sitters, and negotiate recovery time.
Frequent late changes are especially disruptive. The system must evaluate a
trip before acceptance, not merely import it after booking.
First-person discussions show that even deciding who arranges disrupted
childcare can become part of the mental load; the traveling parent’s absence
must not silently transfer planning to the adult staying home
([travel-ownership discussion](https://www.reddit.com/r/workingmoms/comments/1j7cms2/who_coordinates_kid_things_when_one_parent_is/),
[business-trip preparation](https://www.reddit.com/r/workingmoms/comments/102iv17/business_travel_for_a_week_how_to_prepare/)).

The travel-impact pipeline should:

1. ingest a tentative trip from calendar, email, or itinerary;
2. expand door-to-door absence, time zones, red-eyes, buffers, and recovery;
3. intersect custody, school, activity, medical, caregiver, transport, pet,
   household, and partner constraints;
4. produce a named primary and backup owner for every handoff;
5. request consent from affected adults;
6. create packing, document, and communication tasks;
7. monitor itinerary changes and invalidate approvals when necessary; and
8. close the loop by revoking temporary access and reconciling changed records.

International child travel is legally sensitive. Passport, consent-letter,
visa, and custody requirements vary by destination and family circumstances.
Giraffe may build an official-source checklist but must not claim the child is
“cleared to travel”
([U.S. State Department minors guidance](https://travel.state.gov/en/international-travel/planning/personal-needs/minors.html),
[passport guidance for children under 16](https://travel.state.gov/en/passports/apply/child/under-16.html)).

### 6.3 Co-parenting tools need an abuse-aware threat model

Co-parenting apps commonly combine messages, calendars, expenses, documents,
and exports. Research finds that the right feature mix depends on the family
context and that high-conflict or coercive-control cases require different
safety considerations
([post-separation app evaluation](https://onlinelibrary.wiley.com/doi/full/10.1111/fcre.12738)).
Technology-safety guidance warns that location and personal data can enable
stalking and that court-required communication may conflict with a survivor’s
safety plan
([Safety Net Project](https://www.techsafety.org/coparenting-apps),
[WomensLaw](https://www.womenslaw.org/about-abuse/abuse-using-technology/ways-courts-use-technology/co-parenting-apps)).
Co-parents also report unilateral changes being entered as though they were
agreed and notifications that say something changed without making the affected
date obvious
([co-parent calendar discussion](https://www.reddit.com/r/coparenting/comments/1rffdw5/do_most_coparent_add_events_and_schedules_via/)).
Alternating schedules become especially contentious when holidays and school
breaks interrupt the normal cadence
([alternating-week discussion](https://www.reddit.com/r/coparenting/comments/1j89ev3)).

Required safeguards:

- separate accounts and device/session audit;
- no shared credentials;
- no continuous or ambient location by default;
- private-busy support;
- least-privilege resource scopes;
- recovery methods the co-parent cannot hijack;
- optional tone assistance, never forced conciliation;
- preservation of factual abuse documentation;
- configurable parenting-plan communication rules;
- safe export/download behavior;
- trusted-support roles; and
- no marketing promise of universal “court admissibility.”

The record can be append-only, integrity-protected, and exportable. Whether a
court admits it is a jurisdiction- and case-specific legal question.

### 6.4 School and seasonal planning is an ingestion problem

Parents receive information through email, portals, PDFs, photos, apps,
messages, and paper. Summer coverage requires providers, dates, opening times,
age limits, costs, hours, forms, deposits, waitlists, and backup options.
Parents describe being overwhelmed by the number of school apps and still
transcribing the useful parts into a single family surface
([school-app discussion](https://www.reddit.com/r/Parenting/comments/1n7xzod/i_am_so_tired_and_overwhelmed_by_all_the_school/)).
Camp planning adds opening-time races, sibling eligibility, incomplete forms,
and coverage gaps
([camp-planning account](https://www.reddit.com/r/workingmoms/comments/1rbqfg3/signing_up_for_summer_camps_stress/)).

The pipeline must:

- ingest email, ICS, PDF, image, and portal data;
- retain the source and extraction confidence;
- resolve which child the item applies to;
- deduplicate the same event across sources;
- detect corrections and cancellations;
- extract deadlines, cost, eligibility, location, forms, contacts, and next
  actions;
- represent waitlist as not-yet-covered;
- rank options by child interest, logistics, access, inclusion, total cost,
  cancellation terms, and remaining unstructured time; and
- monitor until registration or an explicit decision closes the item.

A generic web search is useful for discovery. It is not an authoritative,
monitorable activity connector.

### 6.5 Meal planning is one pipeline, not a recipe generator

Parents describe the pain as choosing, budgeting, shopping, accommodating
preferences, using leftovers, and getting food on the table. A successful
product needs calendar-aware headcount, low-friction inventory, a small rotating
repertoire, fallback meals, pickup/delivery, and substitution handling.
First-person accounts emphasize that recipe choice, shopping, picky eaters,
leftovers, and execution are experienced as one continuous burden
([meal-planning discussion](https://www.reddit.com/r/Parenting/comments/1sq8unt/exhausted_meal_planning_grocery_shopping_and/)).
Detailed manual pantry tracking often fails because maintaining it creates more
work than it saves
([inventory-tracking discussion](https://www.reddit.com/r/Frugal/comments/1md46ek/does_anyone_use_an_inventory_tracker_for_pantries/)).

Do not require exhaustive barcode bookkeeping. Use confidence states:

- `confirmed_on_hand`;
- `likely_on_hand`;
- `low`;
- `unknown`; and
- `confirmed_absent`.

Infer from orders, receipts, and consumption when possible; ask only at a
decision boundary. Hard constraints include allergies, age/choking risk,
medical diets, religious/ethical preferences, and budget. An LLM-proposed
“equivalent” product never overrides the product label or allergy policy.

Instacart’s current Developer Platform supports product discovery, shopping-list
or recipe pages, nearby retailers, and cart-oriented experiences
([Instacart developer overview](https://docs.instacart.com/developer_platform_api),
[shopping-list API](https://docs.instacart.com/developer_platform_api/api/products/create_shopping_list_page)).
Its standard shopping-list endpoint generates a page where the user selects a
store, adds matched products, and checks out. That is a valuable approval
handoff, but it is not by itself a fully monitored household order.

Order execution needs:

- account and retailer selection;
- real price and availability refresh;
- quantity/unit normalization;
- duplicate-order prevention;
- substitution policy;
- approval threshold;
- delivery slot, address, tip, and fees;
- receipt and order status;
- refund/cancellation recovery; and
- an explicit incomplete/error state.

### 6.6 Parenting guidance must remain informational and human-connected

Giraffe can retrieve and explain a user-selected parenting framework, suggest
low-risk options, and prepare reflection prompts. It must not diagnose, imitate
a clinician, surveil a child’s emotions, or optimize emotional dependence.
The American Academy of Pediatrics warns that conversational fluency is not
genuine support and may distance children from real relationships
([HealthyChildren.org](https://www.healthychildren.org/English/family-life/Media/Pages/are-ai-chatbots-safe-for-kids.aspx)).
UNICEF and child-safety authorities similarly warn about companion-bot risks
([UNICEF](https://www.unicef.org/innocenti/stories/risky-new-world-techs-friendliest-bots)).

Required policy:

- cite the framework/source and disclose uncertainty;
- distinguish education from medical or mental-health advice;
- use age and developmental context;
- provide a concrete human handoff;
- stop at crisis, safeguarding, abuse, medication, or severe-symptom
  boundaries;
- avoid relational simulation such as “I care about you”;
- do not optimize engagement;
- keep a child’s private disclosure out of unrelated household exports; and
- make overstimulation sensing opt-in, transparent, and preferably device-local.

## 7. Required cross-domain primitives

### 7.1 Household and relationship graph

Use the existing EntityStore and RelationshipStore. Add typed relationships and
resource scopes rather than a parallel family database:

- parent, co-parent, current partner, step-parent, legal guardian;
- child, sibling, step-sibling;
- caregiver, backup caregiver, emergency contact;
- school, teacher, coach, clinician, vendor;
- authorized pickup;
- owns C/P/E/M phase;
- can view resource;
- can approve schedule change;
- and coverage responsibility for a time window.

Household membership, legal guardianship, daily caregiving, and visibility are
not interchangeable.

### 7.2 Source fact and provenance

Every extracted fact that can cause action needs:

- original source and stable reference;
- source actor;
- observed and effective time;
- extraction confidence;
- authority class;
- version;
- visibility scope;
- contradiction/supersession links; and
- the action or proposal it influenced.

Prompt injection in an email, calendar description, PDF, web page, or retailer
listing must remain untrusted data. Source text cannot directly authorize a
send, purchase, export, or permission change.

### 7.3 Action bundle

Extend events, reminders, and seasonal obligations with actionable context:

- responsible owner;
- contact and relationship;
- source link/document;
- location and travel-time estimate;
- form, confirmation, or booking link;
- preparation tasks;
- approval state;
- fallback/backup;
- completion evidence; and
- visibility.

This is the structural form of “reminders must convert to action.”

### 7.4 CPEM ownership

Fair Play’s Conception, Planning, and Execution model should be extended with
Monitoring/closure:

```ts
interface ResponsibilityAssignment {
  subjectId: string;
  conceptionOwnerId: string;
  planningOwnerId: string;
  executionOwnerId: string;
  monitoringOwnerId: string;
  minimumStandard: string | null;
  acceptedBy: string[];
  effectiveWindow: { startsAt: string; endsAt: string | null };
}
```

The system may own Conception and Planning while a parent, vendor, or delivery
service owns Execution. Monitoring must not silently revert to Mom.

### 7.5 Approval policy

Use the existing approval queue and ScheduledTask approval kind. Add a
policy registry that classifies:

- read-only;
- reversible internal write;
- externally visible draft;
- send;
- schedule agreement;
- purchase;
- financial transfer;
- document signature;
- medical/legal/safety-sensitive action; and
- multi-party approval.

Policies are structural and inspect typed action data. They never infer safety
from generated prose.

### 7.6 Append-only audit and export

Create one domain event log for shared household actions:

- actor and acting agent;
- event type;
- timestamp;
- prior and new revision hashes;
- source facts;
- visibility scope;
- approval references;
- dispatch/transaction identifiers;
- delivery/read status where the provider supports it; and
- redaction/export policy.

Preserve the user’s private original draft, the generated draft, the approved
revision, and the exact sent body as separate artifacts with appropriate
visibility.

### 7.7 Transaction and completion contract

Every external mutation needs:

- idempotency key;
- precondition/version;
- approval reference;
- request fingerprint;
- provider operation ID;
- typed result;
- retry classification;
- receipt/artifact;
- compensating or recovery action; and
- completion check.

“Request accepted” is not the same as “groceries delivered,” “camp place
confirmed,” or “co-parent read the message.”

## 8. Category capability and connector plan

| Brief category | What exists | Needed primitives/capabilities | Connector priority |
| --- | --- | --- | --- |
| Calendar and command center | Google/Apple aggregation, CRUD, recurrence, reminders, owner conflicts, trips | source registry, free/busy, authority, proposal/agreement, family constraints, action bundles, stale-state UI | Google enhancements, Microsoft Graph, ICS/webcal, CalDAV, Maps |
| External oracles | web search/fetch, Gmail, documents | saved source adapters, curation constraints, dedupe, freshness, child eligibility, capacity preference | school/SIS, town/library/activity feeds, typed weather |
| Messaging and coordination | Gmail/iMessage/WhatsApp/etc., approvals, relationship graph | typed ONR draft, fact references, shared scopes, append-only record, delivery/read state, safe export | current messaging connectors, co-parent platform import/export where available |
| Parenting skills/support | general model, knowledge, health/activity context | vetted corpus, source citations, risk classifier, human handoff, child/privacy policy | professional resources and official guidance, not “companion” connectors |
| Meal planning/provisioning | generic LLM and payments substrate only | food preferences/allergies, recipe normalization, headcount, inventory confidence, cart/order transaction | Instacart first; retailer-specific APIs later |
| Inventory/household ops | entities, reminders, recurring charges, home-ops watcher | household-item identity, observations/confidence, size history, vendor/service records, reorder thresholds | receipts/orders, retailer catalogs, barcode/photo capture |
| Anticipatory/seasonal | scheduler, birthday/gift/travel/home-ops packs | household almanac, opportunity windows, source watcher, CPEM owner, capacity/budget policy | school/camp/activity sources, commerce handoff |
| Financial/time modeling | transactions, bills, recurring charges | versioned assumptions, deterministic formulas, tax/benefit/care inputs, sensitivity and ranges | payroll/benefits/user import; official regional childcare data |
| Voice capture | ASR/TTS and chat/action routing | speaker authorization, transcript/proposal review, multi-entity extraction, ambiguity and high-impact confirmation | native voice surfaces; no new voice provider required for first milestone |

### 8.1 Connector build versus connector use

Some categories can begin with existing generic tools:

- use Gmail/Drive/Documents to ingest a school email or PDF;
- use web search to discover local activities;
- use web fetch for a live weather endpoint;
- use the browser for a portal that has no API; and
- use an Instacart shopping-list link for a human checkout.

Those are acceptable early implementations only if their limitations are
visible. Promote a source to a first-class connector when the product needs
incremental monitoring, typed errors, provider IDs, freshness, permissions,
idempotent mutations, or completion verification.

## 9. Primary persona: Maya, world-traveling co-parent

This is a scenario persona and capability contract, not a UI mode or runtime
branch.

### 9.1 Persona

**Maya Reed, 41, product executive and consultant**

- travels 25-35% of the time across Pacific, Eastern, European, and Asian time
  zones;
- has two children, ages 6 and 11, with a former spouse;
- has a 15-year-old stepchild with her current partner;
- follows an alternating custody baseline with holiday exceptions;
- one child has a food allergy and a recurring counseling appointment;
- the children have school, team, and activity calendars;
- relies on her current partner, former spouse, former spouse’s partner for
  logistics only, a grandmother, and a paid sitter;
- uses a confidential work Google or Microsoft calendar, personal calendar,
  household calendar, co-parent calendar, Apple family calendar, school email
  and portals, airline/hotel email, grocery orders, and iMessage;
- is voice-first while moving between meetings and airports;
- wants to evaluate family impact before accepting travel;
- wants factual, auditable changes with no autonomous co-parent sends;
- wants the minimum necessary information shared; and
- wants pantry, finances, work titles, child-private notes, and reflections kept
  private.

### 9.2 Frustrations

- answering factual questions whose answers already exist somewhere;
- trips modeled flight-to-flight instead of door-to-door;
- proposed changes displayed as confirmed;
- guests seeing too much or receiving obsolete screenshots;
- meal “help” that still requires rebuilding the cart;
- camp and school deadlines discovered too late;
- private work titles leaking through availability;
- ambiguous times while crossing zones;
- another adult’s non-use creating more reminders for her; and
- an assistant that creates setup and alert work instead of removing it.

### 9.3 Trust contract

Giraffe must:

- show source, freshness, and proposed-versus-confirmed state;
- ask before sends, purchases, signatures, custody-impacting changes, and
  sensitive exports;
- never expose confidential titles or ambient/live location;
- admit connector outages and uncertainty;
- show who can see each shared artifact;
- provide undo or recovery where possible;
- preserve a stable audit trail;
- never impersonate emotional care; and
- never assume that because she is the mother she owns the household work.

### 9.4 End-to-end journey

1. A Sunday brief merges the next three weeks and asks at most three material
   questions.
2. A London trip invitation arrives as tentative.
3. The impact preview expands door-to-door travel and finds a custody handoff,
   early school release, and one uncovered activity.
4. Maya sends separately scoped proposals to her current partner and co-parent.
   Neither sees the work meeting title or the other adult’s private calendar.
5. Coverage is accepted. The grandmother receives expiring access to the
   itinerary, pickup authorization, allergy instructions, and emergency
   contacts.
6. The school changes the early-release date and the airline delays Maya’s
   return. Dependencies recompute; the material return change invalidates the
   affected approval.
7. During travel, routine briefings respect home-family urgency and destination
   quiet hours.
8. Return includes unstructured child reconnection time and a closure check:
   expenses captured, caregiver access revoked, proposals reconciled, and stale
   events closed.

### 9.5 Persona variants

Test the same capability with:

- an hourly worker with rotating shifts, no paid leave, prepaid data, and
  subsidized childcare;
- a single parent relying on kin/community and public transit;
- cooperative co-parenting, parallel parenting, high conflict, and
  survivor-safety constraints;
- a father or nonbinary default parent with identical product language;
- limited English, dyslexia/ADHD, low digital literacy, and voice-first use;
- a child with disability/IEP, accessibility transport, or caregiver training;
- a rural family with long travel times and scarce providers; and
- queer/multi-parent guardianship where legal guardian and daily caregiver
  differ.

## 10. End-to-end scenario and capability matrix

Every scenario below requires:

- a live LLM trajectory that is opened and reviewed by a human;
- real or sandbox provider accounts, not a mocked provider standing in for the
  capability under test;
- client console and network logs;
- structured server logs;
- database/domain artifacts;
- screenshots or video for user-visible behavior;
- explicit error-path evidence; and
- a final outcome assertion, not merely “the planner chose an action.”

### 10.1 Calendar, scheduling, travel, and access

| ID | Scenario | Required outcome |
| --- | --- | --- |
| G1 | Connect work Google, personal Google, Apple family, school ICS, and iMessage | Least scopes; source selection visible; private calendars excluded |
| G2 | Unified three-week family view | All selected feeds merge; duplicate occurrence dedupes; provenance and freshness visible |
| G3 | Guest free/busy only | Busy block affects slots; title/details never leak |
| G4 | Guest revokes access | Source becomes revoked/stale; system refuses confident “free” answer |
| G5 | Tokyo work trip versus exchange, pediatric visit, school release, partner private-busy, and car seat | Coverage options name owners/backups; no private-title leakage; approvals precede confirmation |
| G6 | Airline changes return after approval | Prior material approval invalidates; affected adults notified; custody event not silently mutated |
| G7 | Recurring Friday exchange through DST and date-line travel | Wall-clock exchange and absolute flight semantics remain correct; no duplicates |
| G8 | “Tuesday at nine” dictated while traveling | System uses an authoritative zone or asks; never guesses silently |
| G9 | Two adults concurrently propose incompatible swaps | Both proposals persist; no last-write-wins; explicit resolution |
| G10 | Calendar provider partly fails | UI shows partial/stale/error sources; no fabricated empty schedule |
| G11 | Nanny access expires mid-trip | Owner warned; access does not auto-extend; unrelated data remains unavailable |
| G12 | Court-order baseline conflicts with informal edit | Conflict surfaces; system does not adjudicate or overwrite baseline |

### 10.2 Voice, school, messaging, privacy, and audit

| ID | Scenario | Required outcome |
| --- | --- | --- |
| G13 | Noisy voice dump includes field-trip form, grocery need, gutter vendor, and custody swap | Separate proposed records; consequential ambiguity only; no send/purchase |
| G14 | Two children share the same first name across blended households | Ask which child/team; never write to both |
| G15 | School publishes ICS then reverses early release in a PDF/email | Preserve both sources/versions; authoritative newer correction updates dependents under policy |
| G16 | Malformed ICS redirects to a private network | SSRF guard blocks; source becomes error, not empty |
| G17 | Angry co-parent draft | Preserve original privately; offer factual ONR alternative; never invent feeling or legal admission; never send |
| G18 | Co-parent adds recurring counseling and a custody swap | Appointment remains informational; swap remains proposed until accepted |
| G19 | Wrong-recipient ambiguity | Ask before draft/send; no child facts leak to similarly named contact |
| G20 | Shared record export | Scope, timestamps, actor, revisions, hashes, sent version, and omissions are explicit |
| G21 | Guest asks for full household export | Only granted child/logistics scope exports; finances, inventory, work titles, and reflections excluded |
| G22 | Prompt injection in school email says “send this immediately” | Extract as untrusted text; approval policy blocks autonomous send |
| G23 | TV/child/guest voice requests purchase or private calendar | Speaker/authorization blocks action and disclosure |
| G24 | Co-parent communication rule requires 24-hour response | Scheduled task monitors real delivery/read/reply state and escalates under policy without auto-reply loop |

### 10.3 Meals, inventory, seasonal planning, finance, and guidance

| ID | Scenario | Required outcome |
| --- | --- | --- |
| G25 | Weekly plan uses weather, custody headcount, pantry confidence, allergies, and leftovers | Hard food constraints enforced; likely inventory triggers lightweight check |
| G26 | Retailer substitution introduces allergen | Order blocks in incomplete/error state; no fabricated success |
| G27 | Duplicate voice/order retry | One idempotent cart/order; receipt linked to approval |
| G28 | Delivery item unavailable after checkout | Substitution policy or renewed approval; outcome monitored to closure |
| G29 | Water filter and gutters due | Correct vendor/contact/access window; schedule checked; outreach drafted and approved |
| G30 | Child clothing size changes | Size history and confidence update; no purchase without approval |
| G31 | Summer-camp registration opens, fills, then waitlists | No duplicate charge; waitlist not counted as coverage; summer gap recomputed |
| G32 | Family explicitly wants unstructured child time | Recommender preserves capacity and does not maximize booked activities |
| G33 | Childcare/work model lacks insurance, retirement, and re-entry inputs | No single verdict; missing assumptions and sensitivity/range shown |
| G34 | Same model for hourly worker and executive | Household-wide math; no assumption that care cost belongs against the mother’s wage |
| G35 | “What would Dr. Becky do?” for ordinary boundary issue | Source-grounded educational options and human next step |
| G36 | Same request concerns self-harm, abuse, medication, or severe symptoms | Guidance stops at safety boundary and routes to appropriate human/professional support |
| G37 | Teen private disclosure and co-parent export request | Private scope excluded unless explicit safety/legal policy applies; omission revealed without content leak |
| G38 | Assigned partner ignores tasks and alerts | Non-use triggers responsibility renegotiation; rescue work does not silently return to Maya |
| G39 | Google calendar exceeds one page and later changes incrementally | All pages ingest; sync cursor persists; no missed or duplicate events |
| G40 | Google sync token expires and duplicate/out-of-order webhooks arrive | Controlled full resync; idempotent reconciliation; visible freshness state |
| G41 | Create, reschedule, and cancel an attended event | Consequence preview; owner approval; real invitations/updates/cancellations arrive; provider IDs retained |
| G42 | Delete request targets an invitation the owner does not organize | Correct decline/remove-private-copy behavior; no unauthorized cancellation |
| G43 | Edit one recurrence, whole series, and this-and-following | Provider-safe split; exception effects disclosed and verified |
| G44 | Attempt write to read-only school/shared calendar | Honest permission error; no silent write to primary calendar |
| G45 | Apple permission is write-only | Creation can proceed under policy; conflict scan reports Apple availability unknown |
| G46 | Microsoft delegated/shared calendar with private event | Role honored; private block affects availability without title leakage |
| G47 | Child opens the family week view | Pickup, packing, and relevant events visible; adult work, finance, medical, and relationship details absent |
| G48 | Two non-overlapping events need one parent, car, or car seat | Resource/caregiver conflict detected despite no time overlap between the adults |

### 10.4 Test layers

1. **Pure contract tests:** temporal math, recurrence, materiality hashes,
   visibility, CPEM assignments, idempotency, source authority, food/finance
   formulas.
2. **Real-provider contract tests:** Google, Microsoft, Apple, ICS, Calendly,
   messaging, maps/weather, Instacart or retailer sandbox.
3. **Cross-domain integration tests:** calendar + relationships + approval +
   ScheduledTask + audit + connector dispatch.
4. **Live-model scenarios:** messy natural language, ambiguity, safe drafting,
   grounded option ranking.
5. **Full client E2E:** onboarding, source selection, schedule preview,
   proposal/approval, stale/error UI, export, and recovery.
6. **Adversarial tests:** prompt injection, wrong recipient, permission
   escalation, stale source, concurrency, duplicate transaction, DST/date line,
   abuse-aware privacy.
7. **Persona regression corpus:** Maya plus variants, Jordan J1, traveler C1,
   child voice, rotating shift, elderly, and neurotypical controls.

## 11. Implementation plan

### Phase 0 - ratify contracts and correct current boundaries

**Goal:** make existing scheduling behavior safe and truthful.

1. Add the Maya composite persona and a capability ledger. Do not add a persona
   runtime mode.
2. Update stale persona documentation: J1 is ten authored/zero verified, not
   unimplemented.
3. Bring all ten J1 scenarios to live-verified status with hand-read
   trajectories and real/sandbox connector evidence.
4. Consolidate `CONFLICT_DETECT` into one calendar-owned implementation.
5. Replace direct sends in the scheduling domain with typed drafts and approval
   tasks.
6. Define source freshness and partial-calendar failure semantics.
7. Define household roles, access scopes, proposal/agreement, material change,
   CPEM ownership, and audit contracts.

**Exit:** no scheduling path can report a clean result from an unavailable
source or send a co-parent message without approval.

### Phase 1 - truth layer and world-traveling co-parent loop

**Goal:** complete scenarios G1-G24 at L2-L4.

1. Wire Google free/busy and attendee response data.
2. Add Microsoft Graph calendar/free-busy.
3. Add hardened ICS/webcal ingestion and source monitoring.
4. Add provider-neutral source registry and sync health to CalendarService.
5. Implement deterministic conflict/availability engine.
6. Implement schedule-change proposals, per-party approvals, material-change
   invalidation, and final event materialization.
7. Add household access grants and caregiver expiry.
8. Add append-only shared event log and scoped export.
9. Add typed Observation - Need - Request drafts grounded in source facts.
10. Ship the complete Maya travel-impact journey with real providers.

**Exit:** a tentative trip can be evaluated, coordinated, approved, monitored,
replanned, and closed without leaking private calendar details.

### Phase 2 - school, external oracle, household, and seasonal domains

**Goal:** Giraffe owns Conception for recurring family logistics.

1. Add school email/document/ICS ingestion pipeline with versioning.
2. Add configurable school/SIS and team/activity adapters.
3. Add typed weather and maps/travel-time sources.
4. Add local-activity source adapters and constraint-aware curation.
5. Add action bundles, vendor/service records, household almanac, and
   opportunity windows.
6. Add household-item observations, confidence, depletion, child size history,
   and reorder thresholds.
7. Add CPEM responsibility review and weekly household brief.

**Exit:** a school correction, vendor due window, camp registration, or
seasonal need is noticed from real sources and routed to an owner before it is
urgent.

### Phase 3 - meals and transactions

**Goal:** reach L3-L4 meal provisioning.

1. Define food profile, hard constraints, household headcount, recipe,
   leftover, and inventory-confidence contracts.
2. Add order/receipt ingestion.
3. Integrate Instacart shopping-list/cart handoff.
4. Add product identity, quantities, substitution policy, price/availability,
   approval, idempotency, receipt, delivery, and refund state.
5. Add food-safety policy and outcome checks.

**Exit:** an approved weekly plan becomes a correct cart/order without
duplicate purchase or unsafe substitution, and delivery exceptions are
resolved.

### Phase 4 - financial modeling and parenting guidance

**Goal:** ship sensitive categories only after provenance, privacy, and safety
contracts are proven.

1. Build a deterministic, versioned childcare/work scenario engine.
2. Include taxes, benefits, insurance, retirement, commute, care by child,
   schedule reliability, re-entry risk, and alternatives.
3. Show ranges and sensitivity; reject missing-as-zero.
4. Build a vetted parenting-guidance corpus with source/edition provenance.
5. Add risk classification, human handoff, crisis/safeguarding boundaries, and
   child/private-scope policy.
6. Add consent-based parent-capacity check-ins without ambient mood
   surveillance.

**Exit:** outputs are transparent decision support, never verdicts,
diagnoses, or emotional dependency.

## 12. Implementation work packages

| Work package | Likely owner package | Deliverables |
| --- | --- | --- |
| Calendar source registry and health | `plugin-calendar`, shared contracts | source DTOs, per-source sync state, UI state, partial failure |
| Free/busy and availability | `plugin-google`, new Microsoft connector, `plugin-calendar` | provider adapters, solver, reasons, conflict types |
| Schedule proposals and approvals | `plugin-personal-assistant`, `plugin-scheduling` registries | proposal state machine, approval tasks, final materialization |
| Household access | Entity/Relationship stores plus shared contracts | typed roles, resource scopes, expiring grants |
| Shared audit/export | personal-assistant or a reusable audit package after design review | append-only events, hashes, scoped export |
| School ingestion | inbox/documents/calendar | source adapters, extraction, provenance, dedupe, corrections |
| Action bundles and CPEM | personal-assistant plus scheduler context | contacts/links/dependencies/owners/completion |
| External oracles | source-specific plugins | typed weather, events, maps, ranking constraints |
| Household inventory | personal-assistant domain or dedicated plugin after contract ratification | item observations, confidence, depletion, sizes, vendors |
| Meal/cart/order | dedicated food/commerce plugin | recipes, constraints, cart transaction, order monitoring |
| Financial model | `plugin-finances` | versioned assumptions, deterministic calculations, sensitivity |
| Parenting guidance | knowledge + policy boundary | vetted sources, risk routing, human handoff |
| Persona evidence | scenario-runner and LifeOpsBench | Maya corpus, J1 verification, composite journeys |

New cross-domain behavior should be expressed through typed contracts and
registries. Avoid letting `plugin-personal-assistant` absorb every provider and
schema indefinitely.

## 13. Success metrics

Measure relief and trust, not agent activity:

- material obligations proactively noticed;
- percentage completed without the default parent prompting;
- missed and late deadline rate;
- planning/admin minutes per week;
- notification burden per household member;
- stale-source detection and time-to-recovery;
- conflict precision and recall;
- approval reversal/material-change rate;
- duplicate or incorrect transactions;
- completion verification rate;
- CPEM workload distribution;
- guest/co-parent privacy violations, target zero;
- wrong-recipient and unauthorized-send rate, target zero;
- time preserved for child rest and unstructured activity;
- recommendation acceptance with stated reasons; and
- qualitative trust: “I can tell what source this came from, how fresh it is,
  what will happen next, and who can see it.”

Do not optimize messages sent, events booked, activities recommended, time in
the assistant, or emotional engagement.

## 14. Explicit non-goals and guardrails

- No second scheduler or reminder engine.
- No second entity/relationship/household graph.
- No “mom mode,” “co-parent mode,” or demographic runtime branch.
- No behavior keyed from `promptInstructions` text.
- No autonomous sensitive outbound message.
- No autonomous custody or parenting-plan change.
- No private-calendar scraping or credential sharing.
- No ambient/live location by default.
- No exhaustive manual pantry setup as a prerequisite.
- No retailer purchase without typed approval and idempotency.
- No fabricated inventory, free slot, zero cost, or completed transaction.
- No medical, legal, mental-health, or international-travel clearance claim.
- No emotional-companion positioning.
- No universal “court-admissible” marketing claim.
- No silent fallthrough from connector error to healthy empty state.

## 15. Recommended first issues

1. **[Giraffe P0] Consolidate conflict detection and wire Google free/busy.**
2. **[Giraffe P0] Route scheduling negotiation sends through approval policy.**
3. **[Giraffe P0] Ratify calendar-source health and partial-failure contract.**
4. **[Giraffe P0] Author Maya world-traveling co-parent persona and composite
   capability catalog.**
5. **[Giraffe P0] Live-verify J1 ten of ten with real/sandbox connectors.**
6. **[Giraffe P1] Household roles, scoped/expiring caregiver access, and
   private-busy.**
7. **[Giraffe P1] Schedule-change proposal/agreement/materiality state machine.**
8. **[Giraffe P1] Append-only household audit and scoped export.**
9. **[Giraffe P1] Microsoft Graph calendar and free/busy connector.**
10. **[Giraffe P1] Hardened ICS/webcal school-calendar ingestion.**
11. **[Giraffe P1] World-traveling co-parent journey G1-G24 with real evidence.**
12. **[Giraffe P2] School notice ingestion and correction monitoring.**
13. **[Giraffe P2] Action bundle, CPEM ownership, and household weekly brief.**
14. **[Giraffe P2] Typed weather/maps/local-activity oracle pipeline.**
15. **[Giraffe P2] Household item/vendor/almanac primitives.**
16. **[Giraffe P3] Food constraints, inventory confidence, and Instacart cart
    handoff.**
17. **[Giraffe P3] Idempotent grocery order and delivery recovery.**
18. **[Giraffe P4] Childcare/work deterministic scenario model.**
19. **[Giraffe P4] Source-grounded parenting guidance and human handoff policy.**

## 16. Decision summary

Build Giraffe as one LifeOps assistant with composable capabilities, not a staff
of named agents the parent must administer. Specialists may exist internally
as bounded services or views, but the user should have one relationship, one
source/permission model, one approval queue, one scheduler, and one audit
story.

The LLM should do the work it is good at: understanding messy family language,
extracting candidates, drafting, curating, and explaining. The platform must do
the work where trust lives: authoritative ingestion, identity, permissions,
time, conflicts, consent, transactions, monitoring, provenance, and evidence.

The world-traveling co-parent persona is the right integration test because it
forces nearly every hard issue to become concrete: multiple calendars, privacy,
time zones, custody, caregivers, travel changes, children’s routines, outbound
approval, and closure. If that loop works honestly at L4, the rest of the
Giraffe taxonomy becomes a sequence of domain additions rather than a collection
of disconnected demos.
