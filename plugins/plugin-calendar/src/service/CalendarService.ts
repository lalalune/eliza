/**
 * The calendar domain service — the single owner of calendar reads and
 * mutations across the Google and Apple providers.
 *
 * Aggregates each connected account's feed, caches events via
 * `CalendarRepository`, and performs event CRUD, next-event lookup, recurrence
 * handling, and window pruning. A host-injected `CalendarConnectorGate` (from
 * `plugin-lifeops`) supplies Google account/scope selection and reminder/audit
 * hooks; the service never imports the grant registry directly, keeping the
 * dependency direction `plugin-lifeops -> plugin-calendar`.
 */
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  type GoogleCalendarEvent,
  GoogleCalendarSyncTokenExpiredError,
} from "@elizaos/plugin-google";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  FeatureResult,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSourceError,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSourceKey,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
} from "@elizaos/shared";
import {
  APPLE_CALENDAR_ACCOUNT_LABEL,
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  createNativeAppleCalendarEvent,
  deleteNativeAppleCalendarEvent,
  getNativeAppleCalendarFeed,
  isAppleCalendarGrant,
  listNativeAppleCalendars,
  updateNativeAppleCalendarEvent,
} from "../apple-calendar.js";
import {
  buildNextCalendarEventContext,
  normalizeCalendarAttendees,
  normalizeCalendarDateTimeInTimeZone,
  normalizeCalendarId,
  normalizeCalendarTimeZone,
  resolveCalendarEventRange,
  resolveCalendarWindow,
  resolveNextCalendarEventWindow,
} from "../internal/calendar-normalize.js";
import { DEFAULT_CALENDAR_REMINDER_STEPS } from "../internal/constants.js";
import { CalendarServiceError, fail } from "../internal/errors.js";
import {
  accountIdForGrant,
  googleAccountIdFromGrantId,
  googleCalendarEventInput,
  googleCalendarEventPatchInput,
  lifeOpsCalendarEventFromGoogle,
  lifeOpsCalendarSummaryFromGoogle,
  requireGoogleServiceMethod,
} from "../internal/google-delegates.js";
import {
  normalizeOptionalBoolean,
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
  normalizeOptionalString,
  requireNonEmptyString,
} from "../internal/normalize.js";
import {
  normalizeRecurrence,
  normalizeRecurrenceScope,
  recurringEventIdFrom,
} from "../internal/recurrence.js";
import {
  cancelAllMeetingAutoJoinTasks,
  reconcileMeetingAutoJoin,
  restoreMeetingAutoJoinAnchors,
} from "../meetings/auto-join.js";
import {
  isMeetingAutoJoinPolicy,
  type MeetingAutoJoinSettings,
  readMeetingAutoJoinSettings,
  writeMeetingAutoJoinPolicy,
} from "../meetings/auto-join-settings.js";
import {
  CalendarRepository,
  createLifeOpsCalendarSyncState,
} from "./CalendarRepository.js";
import {
  calendarFeedPreferenceKey,
  ensureCalendarFeedIncludes,
  setCalendarFeedIncluded,
} from "./feed-preferences.js";
import {
  type CalendarHostGate,
  createDefaultCalendarHostGate,
  createLifeOpsAuditEvent,
  createLifeOpsReminderPlan,
} from "./gate.js";

type AggregatedCalendarFeedSource = {
  calendar: Pick<
    LifeOpsCalendarSummary,
    "accountEmail" | "calendarId" | "grantId" | "summary"
  >;
  feed: LifeOpsCalendarFeed;
};

type CalendarSourceDiscovery = {
  calendars: LifeOpsCalendarSummary[];
  failures: LifeOpsCalendarSourceHealth[];
};

type AppleCalendarFailure = Extract<FeatureResult<unknown>, { ok: false }>;

type GoogleCalendarSyncBatch = {
  events: GoogleCalendarEvent[];
  nextSyncToken: string | null;
};

const CALENDAR_FEED_FRESHNESS_MS = 60_000;

function googleEventIntersectsWindow(
  event: GoogleCalendarEvent,
  timeMin: string,
  timeMax: string,
): boolean {
  if (event.status === "cancelled" || !event.start || !event.end) {
    return false;
  }
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const windowStart = Date.parse(timeMin);
  const windowEnd = Date.parse(timeMax);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > windowStart &&
    start < windowEnd
  );
}

function calendarSourceKey(
  calendar: Pick<
    LifeOpsCalendarSummary,
    "provider" | "side" | "grantId" | "connectorAccountId" | "calendarId"
  >,
): LifeOpsCalendarSourceKey {
  return {
    provider: calendar.provider,
    side: calendar.side,
    grantId: calendar.grantId,
    connectorAccountId: calendar.connectorAccountId,
    calendarId: calendar.calendarId,
  };
}

function calendarSourceError(error: unknown): LifeOpsCalendarSourceError {
  if (error instanceof CalendarServiceError) {
    return {
      code: error.code ?? "CALENDAR_SOURCE_ERROR",
      message: error.message,
      retryable: error.status >= 500,
    };
  }
  return {
    code: "CALENDAR_SOURCE_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function calendarSourceHealth(args: {
  calendar: Pick<
    LifeOpsCalendarSummary,
    | "provider"
    | "side"
    | "grantId"
    | "connectorAccountId"
    | "calendarId"
    | "summary"
  >;
  status: LifeOpsCalendarSourceHealth["status"];
  syncedAt: string | null;
  error: LifeOpsCalendarSourceError | null;
}): LifeOpsCalendarSourceHealth {
  return {
    key: calendarSourceKey(args.calendar),
    summary: args.calendar.summary,
    status: args.status,
    syncedAt: args.syncedAt,
    error: args.error,
  };
}

function hasGoogleConnectorGrant<
  TStatus extends { grant: LifeOpsConnectorGrant | null },
>(status: TStatus): status is TStatus & { grant: LifeOpsConnectorGrant } {
  return status.grant !== null;
}

function isAppleCalendarFailure(
  result: FeatureResult<unknown>,
): result is AppleCalendarFailure {
  return result.ok === false;
}

function failAppleCalendarResult(
  result: FeatureResult<unknown>,
  operation: string,
): never {
  if (!isAppleCalendarFailure(result)) {
    fail(500, `Apple Calendar ${operation} unexpectedly succeeded.`);
  }
  if (result.reason === "permission") {
    fail(
      403,
      `Apple Calendar permission is required for ${operation}. Grant Calendar access to continue.`,
    );
  }
  if (result.reason === "not_supported") {
    fail(
      409,
      `Apple Calendar is not available on ${result.platform}; connect Google Calendar or use a native Apple platform.`,
    );
  }
  if (
    result.reason === "native_error" &&
    /attendee|invitee|invited meeting/i.test(result.message)
  ) {
    fail(
      409,
      result.message ||
        "Apple Calendar cannot create or edit invited meetings. Connect Google Calendar or remove attendees.",
    );
  }
  fail(
    502,
    result.reason === "native_error" && result.message
      ? result.message
      : `Apple Calendar ${operation} failed through EventKit.`,
  );
}

function appleCalendarPlaceholderSummary(args: {
  calendarId?: string | null;
  timeZone?: string | null;
  side?: LifeOpsConnectorSide | null;
}): LifeOpsCalendarSummary {
  const calendarId = args.calendarId?.trim() || "primary";
  return {
    provider: APPLE_CALENDAR_PROVIDER,
    side: args.side ?? "owner",
    grantId: APPLE_CALENDAR_GRANT_ID,
    connectorAccountId: APPLE_CALENDAR_GRANT_ID,
    accountEmail: null,
    calendarId,
    summary:
      calendarId === "primary" ? APPLE_CALENDAR_ACCOUNT_LABEL : calendarId,
    description: null,
    primary: calendarId === "primary",
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: args.timeZone ?? null,
    selected: true,
    includeInFeed: true,
  };
}

function googleCalendarPlaceholderSummary(
  grant: LifeOpsConnectorGrant,
  calendarId = "all",
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: grant.side,
    grantId: grant.id,
    connectorAccountId: accountIdForGrant(grant),
    accountEmail: grant.identityEmail ?? null,
    calendarId,
    summary: grant.identityEmail
      ? `Google Calendar (${grant.identityEmail})`
      : "Google Calendar",
    description: null,
    primary: calendarId === "primary",
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
  };
}

function failAppleRecurrenceUnsupported(operation: string): never {
  fail(
    400,
    `Apple Calendar does not support recurring-event ${operation} through this integration. Connect Google Calendar for recurring events.`,
    "CALENDAR_RECURRENCE_UNSUPPORTED_PROVIDER",
  );
}

function shouldIncludeAppleCalendar(request: {
  mode?: LifeOpsConnectorMode | null;
  side?: LifeOpsConnectorSide | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.side && request.side !== "owner") return false;
  if (request.grantId && !isAppleCalendarGrant(request.grantId)) return false;
  return true;
}

export function mergeAggregatedCalendarFeedEvents(
  sources: readonly AggregatedCalendarFeedSource[],
): LifeOpsCalendarEvent[] {
  const dedupedEvents = new Map<string, LifeOpsCalendarEvent>();
  for (const source of sources) {
    for (const event of source.feed.events) {
      if (dedupedEvents.has(event.id)) {
        continue;
      }
      dedupedEvents.set(event.id, {
        ...event,
        grantId: event.grantId ?? source.calendar.grantId,
        accountEmail:
          event.accountEmail ?? source.calendar.accountEmail ?? undefined,
        calendarSummary: event.calendarSummary ?? source.calendar.summary,
      });
    }
  }
  return [...dedupedEvents.values()].sort((a, b) =>
    a.startAt.localeCompare(b.startAt),
  );
}

/**
 * Owns the calendar domain: Google + Apple calendar feed, event CRUD, the
 * calendar event/sync store, and the next-event context. Cross-domain concerns
 * (Google connector grants, reminder plans, audit events) are reached through
 * an injected {@link CalendarHostGate}; LifeOps registers its own gate so
 * calendar events keep firing reminders and writing audit rows.
 */
export class CalendarService extends Service {
  static override serviceType = "calendar";
  capabilityDescription =
    "Google + Apple calendar feed, event CRUD, and next-event context for Eliza agents.";

  private readonly repo: CalendarRepository;
  private gate: CalendarHostGate;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.repo = new CalendarRepository(this.runtime);
    this.gate = createDefaultCalendarHostGate(this.runtime);
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<CalendarService> {
    const service = new CalendarService(runtime);
    // Anchor registrations for meeting auto-join are in-memory; restore them
    // for upcoming events so persisted join tasks resolve after a restart.
    // Best-effort: the schema may not be migrated yet on first boot.
    void service.restoreMeetingAutoJoinAnchorsOnBoot();
    return service;
  }

  override async stop(): Promise<void> {}

  private async restoreMeetingAutoJoinAnchorsOnBoot(): Promise<void> {
    try {
      const nowIso = new Date().toISOString();
      const horizonIso = new Date(
        Date.now() + 14 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const events = [
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          "google",
          nowIso,
          horizonIso,
        )),
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          APPLE_CALENDAR_PROVIDER,
          nowIso,
          horizonIso,
        )),
      ];
      await restoreMeetingAutoJoinAnchors(this.runtime, this.agentId(), events);
    } catch (error) {
      logger.debug(
        { src: "calendar:service", error },
        "[CalendarService] Meeting auto-join anchor restore skipped (calendar store not ready yet).",
      );
    }
  }

  async getMeetingAutoJoin(): Promise<MeetingAutoJoinSettings> {
    return readMeetingAutoJoinSettings(this.runtime);
  }

  async setMeetingAutoJoin(policy: unknown): Promise<MeetingAutoJoinSettings> {
    if (!isMeetingAutoJoinPolicy(policy)) {
      throw new CalendarServiceError(
        400,
        'policy must be one of "off", "ask", "all"',
      );
    }
    const settings = await writeMeetingAutoJoinPolicy(this.runtime, policy);
    if (policy === "off") {
      await cancelAllMeetingAutoJoinTasks(this.runtime, this.agentId());
    } else {
      // Re-reconcile upcoming events under the new policy so tasks flip
      // between direct-join and approval-gated without waiting for a sync.
      await this.reconcileUpcomingMeetingAutoJoin();
    }
    return settings;
  }

  private async reconcileUpcomingMeetingAutoJoin(): Promise<void> {
    const nowIso = new Date().toISOString();
    const horizonIso = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const events = [
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        nowIso,
        horizonIso,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        nowIso,
        horizonIso,
      )),
    ];
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events,
    });
  }

  /** LifeOps injects its connector + reminder + audit implementation here. */
  setGate(gate: CalendarHostGate): void {
    this.gate = gate;
  }

  private agentId(): string {
    return this.runtime.agentId;
  }

  private async discoverCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<CalendarSourceDiscovery> {
    const mode = normalizeOptionalConnectorMode(request?.mode, "mode");
    const side = normalizeOptionalConnectorSide(request?.side, "side");
    const statuses = await this.gate.getGoogleConnectorAccounts(
      requestUrl,
      side,
    );
    const grants = statuses
      .filter(hasGoogleConnectorGrant)
      .map((status) => status.grant)
      .filter((grant) =>
        request?.grantId ? grant.id === request.grantId : true,
      )
      .filter((grant) => (mode ? grant.mode === mode : true))
      .filter((grant) => grant.capabilities.includes("google.calendar.read"));
    const summaries: LifeOpsCalendarSummary[] = [];
    const failures: LifeOpsCalendarSourceHealth[] = [];
    if (grants.length > 0) {
      const listCalendars = requireGoogleServiceMethod(
        this.runtime,
        "listCalendars",
      );
      for (const grant of grants) {
        try {
          const entries = await listCalendars({
            accountId: accountIdForGrant(grant),
          });
          summaries.push(
            ...entries.map((entry) =>
              lifeOpsCalendarSummaryFromGoogle({ entry, grant }),
            ),
          );
        } catch (error) {
          // error-policy:J4 Feed discovery retains the failed source so a
          // working second account is presented as partial, never complete.
          const calendar = googleCalendarPlaceholderSummary(grant);
          this.runtime.reportError("calendar:list-source", error, {
            source: calendarSourceKey(calendar),
          });
          failures.push(
            calendarSourceHealth({
              calendar,
              status: "error",
              syncedAt: null,
              error: calendarSourceError(error),
            }),
          );
        }
      }
    }
    if (shouldIncludeAppleCalendar({ mode, side, grantId: request?.grantId })) {
      const appleCalendars = await listNativeAppleCalendars({
        agentId: this.agentId(),
        side: "owner",
        runtime: this.runtime,
      });
      if (appleCalendars.ok) {
        summaries.push(...appleCalendars.data);
      } else if (
        appleCalendars.reason !== "not_supported" ||
        isAppleCalendarGrant(request?.grantId)
      ) {
        const calendar = appleCalendarPlaceholderSummary({
          calendarId: "all",
          side,
        });
        failures.push(
          calendarSourceHealth({
            calendar,
            status:
              appleCalendars.reason === "not_supported"
                ? "disconnected"
                : "error",
            syncedAt: null,
            error: {
              code:
                appleCalendars.reason === "permission"
                  ? "CALENDAR_PERMISSION_REQUIRED"
                  : appleCalendars.reason === "not_supported"
                    ? "CALENDAR_SOURCE_UNSUPPORTED"
                    : "CALENDAR_SOURCE_ERROR",
              message:
                appleCalendars.reason === "not_supported"
                  ? `Apple Calendar is unavailable on ${appleCalendars.platform}.`
                  : appleCalendars.reason === "permission"
                    ? "Apple Calendar permission is required."
                    : appleCalendars.message,
              retryable: appleCalendars.reason !== "not_supported",
            },
          }),
        );
      }
    }
    const preferences = await ensureCalendarFeedIncludes(
      this.runtime,
      summaries.map((summary) => ({
        grantId: summary.grantId,
        calendarId: summary.calendarId,
      })),
    );
    return {
      calendars: summaries.map((summary) => ({
        ...summary,
        includeInFeed:
          preferences.calendarFeedIncludes[
            calendarFeedPreferenceKey(summary.grantId, summary.calendarId)
          ] !== false,
      })),
      failures,
    };
  }

  async listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<LifeOpsCalendarSummary[]> {
    const discovery = await this.discoverCalendars(requestUrl, request);
    if (discovery.calendars.length === 0 && discovery.failures.length > 0) {
      throw new CalendarServiceError(
        503,
        discovery.failures
          .map((source) => source.error?.message)
          .filter((message): message is string => Boolean(message))
          .join(" "),
        "CALENDAR_SOURCES_UNAVAILABLE",
      );
    }
    return discovery.calendars;
  }

  async setCalendarIncluded(
    requestUrl: URL,
    request: {
      calendarId: string;
      includeInFeed: boolean;
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId?: string;
    },
  ): Promise<LifeOpsCalendarSummary> {
    const calendarId = requireNonEmptyString(request.calendarId, "calendarId");
    const includeInFeed = normalizeOptionalBoolean(
      request.includeInFeed,
      "includeInFeed",
    );
    if (includeInFeed === undefined) {
      throw new CalendarServiceError(400, "includeInFeed must be a boolean");
    }
    const calendars = await this.listCalendars(requestUrl, request);
    const calendar = calendars.find(
      (entry) =>
        entry.calendarId === calendarId &&
        (request.grantId ? entry.grantId === request.grantId : true),
    );
    if (!calendar) {
      throw new CalendarServiceError(404, "Calendar not found");
    }
    await setCalendarFeedIncluded(
      this.runtime,
      { grantId: calendar.grantId, calendarId },
      includeInFeed,
    );
    return { ...calendar, includeInFeed };
  }

  private async recordCalendarEventAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
    eventType:
      | "calendar_event_created"
      | "calendar_event_updated"
      | "calendar_event_deleted" = "calendar_event_created",
  ): Promise<void> {
    await this.gate.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType: "calendar_event",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async syncCalendarReminderPlans(
    events: LifeOpsCalendarEvent[],
  ): Promise<void> {
    const eventIds = events.map((event) => event.id);
    const existingPlans = await this.gate.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    const plansByOwnerId = new Map(
      existingPlans.map((plan) => [plan.ownerId, plan]),
    );
    for (const event of events) {
      const existing = plansByOwnerId.get(event.id);
      if (existing) {
        await this.gate.updateReminderPlan({
          ...existing,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      await this.gate.createReminderPlan(
        createLifeOpsReminderPlan({
          agentId: this.agentId(),
          ownerType: "calendar_event",
          ownerId: event.id,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          mutePolicy: {},
          quietHours: {},
        }),
      );
    }
  }

  private async deleteCalendarReminderPlansForEvents(
    eventIds: string[],
  ): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    const plans = await this.gate.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    for (const plan of plans) {
      await this.gate.deleteReminderPlan(this.agentId(), plan.id);
    }
  }

  private async loadGoogleCalendarSyncBatch(args: {
    accountId: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
    syncToken?: string;
  }): Promise<GoogleCalendarSyncBatch> {
    const listEventPage = requireGoogleServiceMethod(
      this.runtime,
      "listEventPage",
    );
    const events: GoogleCalendarEvent[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;

    do {
      const page = await listEventPage({
        accountId: args.accountId,
        calendarId: args.calendarId,
        maxResults: 2500,
        pageToken,
        timeZone: args.timeZone,
        ...(args.syncToken
          ? { syncToken: args.syncToken }
          : { timeMin: args.timeMin, timeMax: args.timeMax }),
      });
      events.push(...page.events);
      if (page.nextSyncToken) {
        nextSyncToken = page.nextSyncToken;
      }
      if (page.nextPageToken && seenPageTokens.has(page.nextPageToken)) {
        throw new ElizaError("Google Calendar repeated an event page token.", {
          code: "GOOGLE_CALENDAR_REPEATED_PAGE_TOKEN",
          context: {
            accountId: args.accountId,
            calendarId: args.calendarId,
            pageToken: page.nextPageToken,
          },
          severity: "fatal",
        });
      }
      pageToken = page.nextPageToken ?? undefined;
      if (pageToken) {
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);

    if (args.syncToken && !nextSyncToken) {
      throw new ElizaError(
        "Google Calendar incremental sync completed without a replacement sync token.",
        {
          code: "GOOGLE_CALENDAR_MISSING_SYNC_TOKEN",
          context: {
            accountId: args.accountId,
            calendarId: args.calendarId,
          },
          severity: "fatal",
        },
      );
    }

    return { events, nextSyncToken };
  }

  private async syncGoogleCalendarFeed(args: {
    requestUrl: URL;
    requestedMode?: LifeOpsConnectorMode;
    requestedSide?: LifeOpsConnectorSide;
    grantId?: string;
    calendarId: string;
    calendarSummary: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const grant = await this.gate.requireGoogleCalendarGrant(
      args.requestUrl,
      args.requestedMode,
      args.requestedSide,
      args.grantId,
    );
    const syncedAt = new Date().toISOString();
    const accountId = accountIdForGrant(grant);
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      "google",
      args.calendarId,
      grant.side,
      grant.id,
    );
    let incremental = Boolean(
      syncState?.nextSyncToken &&
        syncState.windowStartAt <= args.timeMin &&
        syncState.windowEndAt >= args.timeMax,
    );
    let batch: GoogleCalendarSyncBatch;
    try {
      batch = await this.loadGoogleCalendarSyncBatch({
        accountId,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
        ...(incremental && syncState?.nextSyncToken
          ? { syncToken: syncState.nextSyncToken }
          : {}),
      });
    } catch (error) {
      // error-policy:J1 The calendar sync boundary translates Google's
      // expected 410 cursor expiry into the provider-prescribed full snapshot.
      if (!(error instanceof GoogleCalendarSyncTokenExpiredError)) {
        throw error;
      }
      incremental = false;
      batch = await this.loadGoogleCalendarSyncBatch({
        accountId,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
      });
    }

    let nextEvents: LifeOpsCalendarEvent[];
    const removedEventIds = new Set<string>();
    const changedEvents: LifeOpsCalendarEvent[] = [];
    let stateWindowStartAt = args.timeMin;
    let stateWindowEndAt = args.timeMax;

    if (incremental && syncState) {
      stateWindowStartAt = syncState.windowStartAt;
      stateWindowEndAt = syncState.windowEndAt;
      const cached = await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        undefined,
        undefined,
        grant.side,
        grant.id,
      );
      const cachedByExternalId = new Map(
        cached
          .filter((event) => event.calendarId === args.calendarId)
          .map((event) => [event.externalId, event] as const),
      );

      for (const googleEvent of batch.events) {
        const cachedEvent = cachedByExternalId.get(googleEvent.id);
        if (
          !googleEventIntersectsWindow(
            googleEvent,
            stateWindowStartAt,
            stateWindowEndAt,
          )
        ) {
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            "google",
            args.calendarId,
            googleEvent.id,
            grant.side,
            grant.id,
          );
          if (cachedEvent) {
            removedEventIds.add(cachedEvent.id);
          }
          continue;
        }
        const event = lifeOpsCalendarEventFromGoogle({
          event: googleEvent,
          grant,
          agentId: this.agentId(),
          syncedAt,
        });
        await this.repo.upsertCalendarEvent(event, grant.side);
        changedEvents.push(event);
      }
      nextEvents = (
        await this.repo.listCalendarEvents(
          this.agentId(),
          "google",
          args.timeMin,
          args.timeMax,
          grant.side,
          grant.id,
        )
      ).filter((event) => event.calendarId === args.calendarId);
    } else {
      const existingEvents = await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        args.timeMin,
        args.timeMax,
        grant.side,
        grant.id,
      );
      const existingEventsForCalendar = existingEvents.filter(
        (event) => event.calendarId === args.calendarId,
      );
      const fullEvents = batch.events.filter(
        (event) => event.status !== "cancelled",
      );
      nextEvents = fullEvents.map((event) =>
        lifeOpsCalendarEventFromGoogle({
          event,
          grant,
          agentId: this.agentId(),
          syncedAt,
        }),
      );
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      for (const event of existingEventsForCalendar) {
        if (!nextEventIds.has(event.id)) {
          removedEventIds.add(event.id);
        }
      }
      await this.repo.pruneCalendarEventsInWindow(
        this.agentId(),
        "google",
        args.calendarId,
        args.timeMin,
        args.timeMax,
        fullEvents.map((event) => event.id),
        grant.side,
        grant.id,
      );
      for (const event of nextEvents) {
        await this.repo.upsertCalendarEvent(event, grant.side);
      }
      changedEvents.push(...nextEvents);
    }

    const removedIds = [...removedEventIds];
    await this.deleteCalendarReminderPlansForEvents(removedIds);
    await this.syncCalendarReminderPlans(changedEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: changedEvents,
      removedEventIds: removedIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: "google",
        side: grant.side,
        grantId: grant.id,
        connectorAccountId: accountId,
        calendarId: args.calendarId,
        windowStartAt: stateWindowStartAt,
        windowEndAt: stateWindowEndAt,
        nextSyncToken: batch.nextSyncToken,
        syncedAt,
      }),
    );
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: "google",
            side: grant.side,
            grantId: grant.id,
            connectorAccountId: accountId,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
          },
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async syncAppleCalendarFeed(args: {
    calendarId: string;
    calendarSummary: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const syncedAt = new Date().toISOString();
    const existingEvents = await this.repo.listCalendarEvents(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      args.timeMin,
      args.timeMax,
      "owner",
      APPLE_CALENDAR_GRANT_ID,
    );
    const existingEventsForCalendar =
      args.calendarId === "all"
        ? existingEvents
        : existingEvents.filter(
            (event) => event.calendarId === args.calendarId,
          );
    const nativeFeed = await getNativeAppleCalendarFeed({
      agentId: this.agentId(),
      calendarId: args.calendarId === "all" ? null : args.calendarId,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeFeed.ok) {
      failAppleCalendarResult(nativeFeed, "feed");
    }
    const nextEvents = nativeFeed.data.events.map((event) => ({
      ...event,
      syncedAt,
      updatedAt: syncedAt,
    }));
    const nextEventIds = new Set(nextEvents.map((event) => event.id));
    const removedEventIds = existingEventsForCalendar
      .map((event) => event.id)
      .filter((eventId) => !nextEventIds.has(eventId));

    await this.repo.pruneCalendarEventsInWindow(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      args.calendarId,
      args.timeMin,
      args.timeMax,
      nextEvents.map((event) => event.externalId),
      "owner",
    );
    await this.deleteCalendarReminderPlansForEvents(removedEventIds);
    for (const event of nextEvents) {
      await this.repo.upsertCalendarEvent(event, "owner");
    }
    await this.syncCalendarReminderPlans(nextEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: nextEvents,
      removedEventIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: APPLE_CALENDAR_PROVIDER,
        side: "owner",
        grantId: APPLE_CALENDAR_GRANT_ID,
        connectorAccountId: APPLE_CALENDAR_GRANT_ID,
        calendarId: args.calendarId,
        windowStartAt: args.timeMin,
        windowEndAt: args.timeMax,
        nextSyncToken: null,
        syncedAt,
      }),
    );
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: APPLE_CALENDAR_PROVIDER,
            side: "owner",
            grantId: APPLE_CALENDAR_GRANT_ID,
            connectorAccountId: APPLE_CALENDAR_GRANT_ID,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
          },
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async readCachedCalendarFeed(args: {
    calendar: LifeOpsCalendarSummary;
    timeMin: string;
    timeMax: string;
    now: Date;
    allowStale: boolean;
    error: LifeOpsCalendarSourceError | null;
  }): Promise<LifeOpsCalendarFeed | null> {
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      args.calendar.provider,
      args.calendar.calendarId,
      args.calendar.side,
      args.calendar.grantId,
    );
    if (!syncState) {
      return null;
    }
    const coversWindow =
      syncState.windowStartAt <= args.timeMin &&
      syncState.windowEndAt >= args.timeMax;
    const ageMs = args.now.getTime() - Date.parse(syncState.syncedAt);
    const fresh =
      coversWindow &&
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs <= CALENDAR_FEED_FRESHNESS_MS;
    if (!fresh && !args.allowStale) {
      return null;
    }
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      args.calendar.provider,
      args.timeMin,
      args.timeMax,
      args.calendar.side,
      args.calendar.grantId,
    );
    return {
      calendarId: args.calendar.calendarId,
      events,
      source: "cache",
      state: fresh ? "complete" : "partial",
      sources: [
        calendarSourceHealth({
          calendar: args.calendar,
          status: fresh ? "fresh" : "stale",
          syncedAt: syncState.syncedAt,
          error: args.error,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: syncState.syncedAt,
    };
  }

  private unavailableCalendarFeed(args: {
    calendar: LifeOpsCalendarSummary;
    timeMin: string;
    timeMax: string;
    error: LifeOpsCalendarSourceError;
  }): LifeOpsCalendarFeed {
    return {
      calendarId: args.calendar.calendarId,
      events: [],
      source: "cache",
      state: "unavailable",
      sources: [
        calendarSourceHealth({
          calendar: args.calendar,
          status: "error",
          syncedAt: null,
          error: args.error,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: null,
    };
  }

  async getCalendarFeed(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsCalendarFeed> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const explicitCalendarId = normalizeOptionalString(request.calendarId);
    const includeHiddenCalendars =
      normalizeOptionalBoolean(
        request.includeHiddenCalendars,
        "includeHiddenCalendars",
      ) ?? false;
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const { timeMin, timeMax } = resolveCalendarWindow({
      now,
      timeZone,
      requestedTimeMin: request.timeMin,
      requestedTimeMax: request.timeMax,
    });
    const forceSync =
      normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;

    const discovery = await this.discoverCalendars(requestUrl, {
      mode,
      side,
      grantId: request.grantId,
    });
    const listedCalendars = discovery.calendars;
    const discoveryFailures = discovery.failures.filter((source) => {
      if (request.grantId && source.key.grantId !== request.grantId) {
        return false;
      }
      return explicitCalendarId
        ? source.key.calendarId === "all" ||
            source.key.calendarId === normalizeCalendarId(explicitCalendarId)
        : true;
    });
    const calendars = listedCalendars.filter((calendar) => {
      if (
        !includeHiddenCalendars &&
        !explicitCalendarId &&
        !calendar.includeInFeed
      ) {
        return false;
      }
      return explicitCalendarId
        ? calendar.calendarId === normalizeCalendarId(explicitCalendarId)
        : true;
    });
    if (calendars.length === 0) {
      if (discoveryFailures.length > 0) {
        return {
          calendarId: explicitCalendarId ?? "all",
          events: [],
          source: "cache",
          state: "unavailable",
          sources: discoveryFailures,
          timeMin,
          timeMax,
          syncedAt: null,
        };
      }
      if (
        explicitCalendarId &&
        request.grantId &&
        !isAppleCalendarGrant(request.grantId)
      ) {
        calendars.push({
          provider: "google",
          side: side ?? "owner",
          grantId: request.grantId,
          connectorAccountId:
            googleAccountIdFromGrantId(request.grantId) ?? request.grantId,
          accountEmail: null,
          calendarId: normalizeCalendarId(explicitCalendarId),
          summary: explicitCalendarId,
          description: null,
          primary: explicitCalendarId === "primary",
          accessRole: "reader",
          backgroundColor: null,
          foregroundColor: null,
          timeZone,
          selected: true,
          includeInFeed: true,
        });
      } else if (
        shouldIncludeAppleCalendar({ mode, side, grantId: request.grantId })
      ) {
        calendars.push(
          appleCalendarPlaceholderSummary({
            calendarId: explicitCalendarId
              ? normalizeCalendarId(explicitCalendarId)
              : "all",
            timeZone,
            side,
          }),
        );
      } else {
        const disconnected: LifeOpsCalendarSummary = {
          provider: "google",
          side: side ?? "owner",
          grantId: request.grantId ?? "disconnected",
          connectorAccountId: request.grantId ?? "disconnected",
          accountEmail: null,
          calendarId: explicitCalendarId ?? "all",
          summary: "Google Calendar",
          description: null,
          primary: explicitCalendarId === "primary",
          accessRole: "none",
          backgroundColor: null,
          foregroundColor: null,
          timeZone,
          selected: false,
          includeInFeed: false,
        };
        return {
          calendarId: disconnected.calendarId,
          events: [],
          source: "cache",
          state: "unavailable",
          sources: [
            calendarSourceHealth({
              calendar: disconnected,
              status: "disconnected",
              syncedAt: null,
              error: {
                code: "CALENDAR_SOURCE_DISCONNECTED",
                message: "No authorized calendar source is connected.",
                retryable: true,
              },
            }),
          ],
          timeMin,
          timeMax,
          syncedAt: null,
        };
      }
    }
    return this.aggregateCalendarFeedsAcrossCalendars(
      requestUrl,
      calendars,
      timeMin,
      timeMax,
      timeZone,
      forceSync,
      now,
      discoveryFailures,
    );
  }

  private async aggregateCalendarFeedsAcrossCalendars(
    requestUrl: URL,
    calendars: LifeOpsCalendarSummary[],
    timeMin: string,
    timeMax: string,
    timeZone: string,
    forceSync: boolean,
    now = new Date(),
    discoveryFailures: readonly LifeOpsCalendarSourceHealth[] = [],
  ): Promise<LifeOpsCalendarFeed> {
    const sources: AggregatedCalendarFeedSource[] = [];
    for (const calendar of calendars) {
      let feed = forceSync
        ? null
        : await this.readCachedCalendarFeed({
            calendar,
            timeMin,
            timeMax,
            now,
            allowStale: false,
            error: null,
          });
      if (!feed) {
        try {
          feed =
            calendar.provider === APPLE_CALENDAR_PROVIDER
              ? await this.syncAppleCalendarFeed({
                  calendarId: calendar.calendarId,
                  calendarSummary: calendar.summary,
                  timeMin,
                  timeMax,
                  timeZone,
                })
              : await this.syncGoogleCalendarFeed({
                  requestUrl,
                  requestedSide: calendar.side,
                  grantId: calendar.grantId,
                  calendarId: calendar.calendarId,
                  calendarSummary: calendar.summary,
                  timeMin,
                  timeMax,
                  timeZone,
                });
        } catch (error) {
          // error-policy:J4 A stale/error source is returned explicitly so one
          // failed account cannot masquerade as either a complete or empty feed.
          const sourceError = calendarSourceError(error);
          this.runtime.reportError("calendar:feed-source", error, {
            source: calendarSourceKey(calendar),
          });
          feed =
            (await this.readCachedCalendarFeed({
              calendar,
              timeMin,
              timeMax,
              now,
              allowStale: true,
              error: sourceError,
            })) ??
            this.unavailableCalendarFeed({
              calendar,
              timeMin,
              timeMax,
              error: sourceError,
            });
        }
      }
      sources.push({ calendar, feed });
    }
    const health = [
      ...discoveryFailures,
      ...sources.flatMap((source) => source.feed.sources),
    ];
    const allFresh = health.every((source) => source.status === "fresh");
    const hasUsableSource = health.some(
      (source) => source.status === "fresh" || source.status === "stale",
    );
    const state = allFresh
      ? "complete"
      : hasUsableSource
        ? "partial"
        : "unavailable";
    const syncedTimes = health
      .map((source) => source.syncedAt)
      .filter((value): value is string => value !== null)
      .sort();
    return {
      calendarId: calendars.length === 1 ? calendars[0].calendarId : "all",
      events: mergeAggregatedCalendarFeedEvents(sources),
      source: sources.every((source) => source.feed.source === "synced")
        ? "synced"
        : "cache",
      state,
      sources: health,
      timeMin,
      timeMax,
      syncedAt: syncedTimes.at(-1) ?? null,
    };
  }

  private async findCachedCalendarEventOwnerIds(args: {
    provider: "google" | typeof APPLE_CALENDAR_PROVIDER;
    externalEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId?: string | null;
  }): Promise<string[]> {
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      args.provider,
      undefined,
      undefined,
      args.side,
    );
    return events
      .filter((event) => event.externalId === args.externalEventId)
      .filter((event) =>
        args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true,
      )
      .filter((event) => (args.grantId ? event.grantId === args.grantId : true))
      .map((event) => event.id);
  }

  async createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    // Validate recurrence up front so an invalid rule fails the request
    // instead of silently creating a one-off event.
    const recurrence = normalizeRecurrence(request.recurrence);
    const { startAt, endAt, timeZone } = resolveCalendarEventRange(
      request,
      now,
    );
    if (isAppleCalendarGrant(request.grantId)) {
      return this.createAppleCalendarEvent(request, calendarId, {
        startAt,
        endAt,
        timeZone,
      });
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      if (request.grantId) {
        throw error;
      }
      return this.createAppleCalendarEvent(request, calendarId, {
        startAt,
        endAt,
        timeZone,
      });
    }
    const createEvent = requireGoogleServiceMethod(this.runtime, "createEvent");
    const googleEvent = await createEvent(
      googleCalendarEventInput({
        accountId: accountIdForGrant(grant),
        calendarId,
        title: requireNonEmptyString(request.title, "title"),
        startAt,
        endAt,
        timeZone,
        description: normalizeOptionalString(request.description),
        location: normalizeOptionalString(request.location),
        attendees: normalizeCalendarAttendees(request.attendees),
        recurrence,
      }),
    );
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event created through plugin-google",
      { calendarId, title: request.title },
      { externalId: event.externalId },
    );
    return event;
  }

  private async createAppleCalendarEvent(
    request: CreateLifeOpsCalendarEventRequest,
    calendarId: string,
    range: { startAt: string; endAt: string; timeZone: string },
  ): Promise<LifeOpsCalendarEvent> {
    if (normalizeRecurrence(request.recurrence)) {
      failAppleRecurrenceUnsupported("create");
    }
    const nativeEvent = await createNativeAppleCalendarEvent({
      agentId: this.agentId(),
      request: {
        ...request,
        calendarId,
        startAt: range.startAt,
        endAt: range.endAt,
        timeZone: range.timeZone,
      },
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeEvent.ok) {
      failAppleCalendarResult(nativeEvent, "create");
    }
    await this.repo.upsertCalendarEvent(nativeEvent.data, "owner");
    await this.syncCalendarReminderPlans([nativeEvent.data]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [nativeEvent.data],
    });
    await this.recordCalendarEventAudit(
      nativeEvent.data.id,
      "calendar event created through native Apple Calendar",
      { calendarId, title: request.title },
      { externalId: nativeEvent.data.externalId },
    );
    return nativeEvent.data;
  }

  async updateCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
    },
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const recurrence = normalizeRecurrence(request.recurrence);
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    if (recurrence && recurrenceScope === "instance") {
      fail(
        400,
        'Recurrence rules apply to the whole series. Use recurrenceScope "series" to change how an event repeats.',
        "CALENDAR_RECURRENCE_SCOPE_CONFLICT",
      );
    }
    const timeZone = request.timeZone
      ? normalizeCalendarTimeZone(request.timeZone)
      : undefined;
    const parseTimeZone = timeZone ?? normalizeCalendarTimeZone(undefined);
    const nativePatch = {
      calendarId: request.calendarId ?? undefined,
      title: request.title,
      description: request.description,
      location: request.location,
      startAt: request.startAt
        ? normalizeCalendarDateTimeInTimeZone(
            request.startAt,
            "startAt",
            parseTimeZone,
          )
        : undefined,
      endAt: request.endAt
        ? normalizeCalendarDateTimeInTimeZone(
            request.endAt,
            "endAt",
            parseTimeZone,
          )
        : undefined,
      timeZone,
      attendees:
        request.attendees === undefined
          ? undefined
          : normalizeCalendarAttendees(request.attendees),
    };
    if (isAppleCalendarGrant(request.grantId)) {
      if (recurrence || recurrenceScope) {
        failAppleRecurrenceUnsupported("update");
      }
      return this.updateAppleCalendarEvent(request.eventId, nativePatch);
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      if (request.grantId) {
        throw error;
      }
      if (recurrence || recurrenceScope) {
        failAppleRecurrenceUnsupported("update");
      }
      return this.updateAppleCalendarEvent(request.eventId, nativePatch);
    }
    let targetEventId = requireNonEmptyString(request.eventId, "eventId");
    // A series edit addressed through a flattened occurrence must patch the
    // series master; a recurrence-rule change is always a series edit.
    if (recurrenceScope === "series" || (recurrence && !recurrenceScope)) {
      targetEventId = await this.resolveSeriesMasterEventId({
        grant,
        calendarId: request.calendarId,
        eventId: targetEventId,
      });
    }
    const updateEvent = requireGoogleServiceMethod(this.runtime, "updateEvent");
    const googleEvent = await updateEvent(
      googleCalendarEventPatchInput({
        accountId: accountIdForGrant(grant),
        calendarId: request.calendarId,
        eventId: targetEventId,
        recurrence,
        title: request.title,
        description: request.description,
        location: request.location,
        startAt: request.startAt
          ? normalizeCalendarDateTimeInTimeZone(
              request.startAt,
              "startAt",
              parseTimeZone,
            )
          : undefined,
        endAt: request.endAt
          ? normalizeCalendarDateTimeInTimeZone(
              request.endAt,
              "endAt",
              parseTimeZone,
            )
          : undefined,
        timeZone,
        attendees:
          request.attendees === undefined
            ? undefined
            : normalizeCalendarAttendees(request.attendees),
      }),
    );
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event updated through plugin-google",
      { eventId: request.eventId },
      { externalId: event.externalId },
      "calendar_event_updated",
    );
    return event;
  }

  private async updateAppleCalendarEvent(
    eventId: string,
    nativePatch: Parameters<
      typeof updateNativeAppleCalendarEvent
    >[0]["request"],
  ): Promise<LifeOpsCalendarEvent> {
    const nativeEvent = await updateNativeAppleCalendarEvent({
      agentId: this.agentId(),
      eventId: requireNonEmptyString(eventId, "eventId"),
      request: nativePatch,
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeEvent.ok) {
      failAppleCalendarResult(nativeEvent, "update");
    }
    await this.repo.upsertCalendarEvent(nativeEvent.data, "owner");
    await this.syncCalendarReminderPlans([nativeEvent.data]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [nativeEvent.data],
    });
    await this.recordCalendarEventAudit(
      nativeEvent.data.id,
      "calendar event updated through native Apple Calendar",
      { eventId },
      { externalId: nativeEvent.data.externalId },
      "calendar_event_updated",
    );
    return nativeEvent.data;
  }

  async deleteCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
    },
  ): Promise<void> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    if (isAppleCalendarGrant(request.grantId)) {
      if (recurrenceScope) {
        failAppleRecurrenceUnsupported("delete");
      }
      await this.deleteAppleCalendarEvent(eventId, request.calendarId);
      return;
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      if (request.grantId) {
        throw error;
      }
      if (recurrenceScope) {
        failAppleRecurrenceUnsupported("delete");
      }
      await this.deleteAppleCalendarEvent(eventId, request.calendarId);
      return;
    }
    // A series delete addressed through a flattened occurrence deletes the
    // series master — one provider call, never an iteration over occurrences.
    const targetEventId =
      recurrenceScope === "series"
        ? await this.resolveSeriesMasterEventId({
            grant,
            calendarId: request.calendarId,
            eventId,
          })
        : eventId;
    const deleteEvent = requireGoogleServiceMethod(this.runtime, "deleteEvent");
    await deleteEvent({
      accountId: accountIdForGrant(grant),
      calendarId: request.calendarId ?? undefined,
      eventId: targetEventId,
    });
    let removedOwnerIds: string[];
    if (recurrenceScope === "series") {
      // Purge every cached flattened occurrence of the deleted series so the
      // cache does not serve ghost instances until the next sync.
      const cachedSeries = await this.findCachedSeriesEvents({
        masterEventId: targetEventId,
        calendarId: request.calendarId,
        side: grant.side,
        grantId: grant.id,
      });
      for (const cachedEvent of cachedSeries) {
        await this.repo.deleteCalendarEventByExternalId(
          this.agentId(),
          "google",
          cachedEvent.calendarId,
          cachedEvent.externalId,
          grant.side,
          grant.id,
        );
      }
      removedOwnerIds = cachedSeries.map((cachedEvent) => cachedEvent.id);
      await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    } else {
      removedOwnerIds = await this.findCachedCalendarEventOwnerIds({
        provider: "google",
        externalEventId: targetEventId,
        calendarId: request.calendarId,
        side: grant.side,
        grantId: grant.id,
      });
      await this.repo.deleteCalendarEventByExternalId(
        this.agentId(),
        "google",
        request.calendarId,
        targetEventId,
        grant.side,
        grant.id,
      );
      await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    }
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [],
      removedEventIds: removedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      targetEventId,
      "calendar event deleted through plugin-google",
      { eventId: targetEventId, recurrenceScope: recurrenceScope ?? null },
      { deleted: true },
      "calendar_event_deleted",
    );
  }

  /**
   * Resolve the series master id for an event id that may address a flattened
   * recurring occurrence: cached instance metadata first, then a provider
   * lookup. An id with no `recurringEventId` already is the master.
   */
  private async resolveSeriesMasterEventId(args: {
    grant: LifeOpsConnectorGrant;
    calendarId?: string | null;
    eventId: string;
  }): Promise<string> {
    const cached = await this.repo.listCalendarEvents(
      this.agentId(),
      "google",
      undefined,
      undefined,
      args.grant.side,
    );
    const match = cached.find(
      (event) =>
        event.externalId === args.eventId &&
        (args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true) &&
        (event.grantId ? event.grantId === args.grant.id : true),
    );
    const cachedMaster = recurringEventIdFrom(match ?? null);
    if (cachedMaster) {
      return cachedMaster;
    }
    if (match) {
      // Cached and not an occurrence: the id addresses the master directly.
      return args.eventId;
    }
    const getEvent = requireGoogleServiceMethod(this.runtime, "getEvent");
    const googleEvent = await getEvent({
      accountId: accountIdForGrant(args.grant),
      calendarId: args.calendarId ?? undefined,
      eventId: args.eventId,
    });
    return recurringEventIdFrom(googleEvent) ?? args.eventId;
  }

  private async findCachedSeriesEvents(args: {
    masterEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId: string;
  }): Promise<LifeOpsCalendarEvent[]> {
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      "google",
      undefined,
      undefined,
      args.side,
    );
    return events
      .filter(
        (event) =>
          event.externalId === args.masterEventId ||
          recurringEventIdFrom(event) === args.masterEventId,
      )
      .filter((event) =>
        args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true,
      )
      .filter((event) =>
        event.grantId ? event.grantId === args.grantId : true,
      );
  }

  private async deleteAppleCalendarEvent(
    eventId: string,
    calendarId: string | null | undefined,
  ): Promise<void> {
    const cachedOwnerIds = await this.findCachedCalendarEventOwnerIds({
      provider: APPLE_CALENDAR_PROVIDER,
      externalEventId: eventId,
      calendarId,
      side: "owner",
      grantId: APPLE_CALENDAR_GRANT_ID,
    });
    const deleted = await deleteNativeAppleCalendarEvent(eventId, {
      runtime: this.runtime,
    });
    if (!deleted.ok) {
      failAppleCalendarResult(deleted, "delete");
    }
    await this.repo.deleteCalendarEventByExternalId(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      calendarId,
      eventId,
      "owner",
      APPLE_CALENDAR_GRANT_ID,
    );
    await this.deleteCalendarReminderPlansForEvents(cachedOwnerIds);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [],
      removedEventIds: cachedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      eventId,
      "calendar event deleted through native Apple Calendar",
      { eventId },
      { deleted: true },
      "calendar_event_deleted",
    );
  }

  async getNextCalendarEventContext(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsNextCalendarEventContext> {
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const { timeMin, timeMax } = resolveNextCalendarEventWindow({
      now,
      timeZone,
    });
    const feed = await this.getCalendarFeed(
      requestUrl,
      {
        ...request,
        timeMin,
        timeMax,
        includeHiddenCalendars: false,
      },
      now,
    );
    if (feed.state === "unavailable") {
      throw new CalendarServiceError(
        503,
        "Calendar sources are unavailable, so the next event cannot be determined.",
        "CALENDAR_SOURCES_UNAVAILABLE",
      );
    }
    const nextEvent =
      feed.events.find((event) => Date.parse(event.endAt) >= now.getTime()) ??
      null;
    return {
      ...buildNextCalendarEventContext(nextEvent, now),
      calendarFeedState: feed.state,
      calendarSources: feed.sources,
    };
  }
}
