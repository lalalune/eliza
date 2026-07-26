/**
 * Integrity binding for approval-gated scheduling messages. Draft creation,
 * queue validation, and post-approval execution share this canonical envelope
 * so approval always applies to one recipient, channel, subject, and body.
 */
import { createHash } from "node:crypto";
import {
  type ApprovalPayload,
  SCHEDULING_APPROVAL_MESSAGE_KINDS,
  SCHEDULING_APPROVAL_TRANSPORT_CHANNELS,
  type SchedulingApprovalCorrelation,
} from "./approval-queue.types.js";

type SchedulingSendPayload = Extract<
  ApprovalPayload,
  { action: "send_message" | "send_email" }
>;

export type SchedulingApprovalCorrelationSeed = Omit<
  SchedulingApprovalCorrelation,
  "contentSha256"
>;

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `[SchedulingApproval] invalid ${label}.${field}: expected non-empty string`,
    );
  }
  return value;
}

function parseSchedulingCorrelation(
  value: unknown,
  label: string,
): SchedulingApprovalCorrelation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `[SchedulingApproval] invalid ${label}: expected scheduling correlation object`,
    );
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "scheduling_message") {
    throw new Error(
      `[SchedulingApproval] invalid ${label}.kind: expected scheduling_message`,
    );
  }
  const negotiationId = requireNonEmptyString(record, "negotiationId", label);
  const proposalId =
    record.proposalId === null
      ? null
      : requireNonEmptyString(record, "proposalId", label);
  if (
    !SCHEDULING_APPROVAL_MESSAGE_KINDS.includes(
      record.messageKind as SchedulingApprovalCorrelation["messageKind"],
    )
  ) {
    throw new Error(
      `[SchedulingApproval] invalid ${label}.messageKind: unsupported value`,
    );
  }
  if (
    !SCHEDULING_APPROVAL_TRANSPORT_CHANNELS.includes(
      record.transportChannel as SchedulingApprovalCorrelation["transportChannel"],
    )
  ) {
    throw new Error(
      `[SchedulingApproval] invalid ${label}.transportChannel: unsupported value`,
    );
  }
  const sourceUpdatedAt = requireNonEmptyString(
    record,
    "sourceUpdatedAt",
    label,
  );
  if (!Number.isFinite(Date.parse(sourceUpdatedAt))) {
    throw new Error(
      `[SchedulingApproval] invalid ${label}.sourceUpdatedAt: expected ISO-8601 timestamp`,
    );
  }
  if (record.draftVersion !== 1) {
    throw new Error(
      `[SchedulingApproval] invalid ${label}.draftVersion: expected 1`,
    );
  }
  const contentSha256 = requireNonEmptyString(record, "contentSha256", label);
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
    throw new Error(
      `[SchedulingApproval] invalid ${label}.contentSha256: expected lowercase SHA-256`,
    );
  }
  return {
    kind: "scheduling_message",
    negotiationId,
    proposalId,
    messageKind:
      record.messageKind as SchedulingApprovalCorrelation["messageKind"],
    transportChannel:
      record.transportChannel as SchedulingApprovalCorrelation["transportChannel"],
    sourceUpdatedAt,
    draftVersion: 1,
    contentSha256,
  };
}

export function readSchedulingApprovalCorrelation(
  payload: ApprovalPayload,
  label = "payload.scheduling",
): SchedulingApprovalCorrelation | null {
  if (payload.action !== "send_message" && payload.action !== "send_email") {
    return null;
  }
  if (payload.scheduling === undefined) {
    return null;
  }
  return parseSchedulingCorrelation(payload.scheduling, label);
}

function canonicalSchedulingEnvelope(
  payload: SchedulingSendPayload,
  scheduling: SchedulingApprovalCorrelation,
): Record<string, unknown> {
  const schedulingIdentity = {
    kind: scheduling.kind,
    negotiationId: scheduling.negotiationId,
    proposalId: scheduling.proposalId,
    messageKind: scheduling.messageKind,
    transportChannel: scheduling.transportChannel,
    sourceUpdatedAt: scheduling.sourceUpdatedAt,
    draftVersion: scheduling.draftVersion,
  };
  if (payload.action === "send_email") {
    return {
      scheduling: schedulingIdentity,
      delivery: {
        action: payload.action,
        to: [...payload.to],
        cc: [...payload.cc],
        bcc: [...payload.bcc],
        subject: payload.subject,
        body: payload.body,
        threadId: payload.threadId,
        replyToMessageId: payload.replyToMessageId ?? null,
      },
    };
  }
  return {
    scheduling: schedulingIdentity,
    delivery: {
      action: payload.action,
      recipient: payload.recipient,
      body: payload.body,
      replyToMessageId: payload.replyToMessageId,
    },
  };
}

export function computeSchedulingApprovalContentSha256(
  payload: SchedulingSendPayload,
): string {
  const scheduling = readSchedulingApprovalCorrelation(payload);
  if (!scheduling) {
    throw new Error(
      "[SchedulingApproval] cannot hash a payload without scheduling correlation",
    );
  }
  return createHash("sha256")
    .update(JSON.stringify(canonicalSchedulingEnvelope(payload, scheduling)))
    .digest("hex");
}

export function attachSchedulingApprovalCorrelation<
  T extends SchedulingSendPayload,
>(
  payload: T,
  seed: SchedulingApprovalCorrelationSeed,
): T & { scheduling: SchedulingApprovalCorrelation } {
  const provisional: SchedulingApprovalCorrelation = {
    ...seed,
    contentSha256: "0".repeat(64),
  };
  const correlated = { ...payload, scheduling: provisional };
  return {
    ...payload,
    scheduling: {
      ...provisional,
      contentSha256: computeSchedulingApprovalContentSha256(correlated),
    },
  };
}

export function verifySchedulingApprovalContent(payload: ApprovalPayload): {
  correlation: SchedulingApprovalCorrelation;
  actualSha256: string;
  matches: boolean;
} | null {
  const correlation = readSchedulingApprovalCorrelation(payload);
  if (!correlation) {
    return null;
  }
  const actualSha256 = computeSchedulingApprovalContentSha256(
    payload as SchedulingSendPayload,
  );
  return {
    correlation,
    actualSha256,
    matches: actualSha256 === correlation.contentSha256,
  };
}
