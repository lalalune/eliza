/**
 * Claims, persists, and replays tenant-scoped TTS operations. The database is
 * authoritative for concurrency while private R2 objects retain successful
 * audio beyond browser timeouts and app pause/resume cycles.
 */
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { type VoiceTtsOperation, voiceTtsOperations } from "../../db/schemas/voice-tts-operations";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";

const OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_REPLAY_AUDIO_BYTES = 64 * 1024 * 1024;
const PRIVATE_RESULT_PREFIX = "private/voice-tts-operations";

const textEncoder = new TextEncoder();

export interface CanonicalVoiceTtsRequest {
  text: string;
  provider: "kokoro" | "cartesia" | "elevenlabs";
  voiceId: string;
  modelId: string;
  format: "mp3" | "wav";
  affiliateCode: string | null;
}

export interface StoredVoiceTtsResult {
  bytes: Uint8Array;
  contentType: string;
  headers: Record<string, string>;
}

export type VoiceTtsOperationClaim =
  | { kind: "claimed"; operation: VoiceTtsOperation; keyHashPrefix: string }
  | { kind: "conflict"; operation: VoiceTtsOperation; keyHashPrefix: string }
  | { kind: "pending"; operation: VoiceTtsOperation; keyHashPrefix: string }
  | {
      kind: "completed";
      operation: VoiceTtsOperation;
      keyHashPrefix: string;
      result: StoredVoiceTtsResult;
    }
  | {
      kind: "failed";
      operation: VoiceTtsOperation;
      keyHashPrefix: string;
      status: number;
      body: Record<string, unknown>;
    };

export class InvalidVoiceTtsIdempotencyKeyError extends Error {
  constructor() {
    super(
      `Idempotency-Key must be ${MIN_IDEMPOTENCY_KEY_LENGTH}-${MAX_IDEMPOTENCY_KEY_LENGTH} visible ASCII characters`,
    );
    this.name = "InvalidVoiceTtsIdempotencyKeyError";
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function normalizeVoiceTtsIdempotencyKey(rawKey: string | null): string | null {
  if (rawKey === null) return null;
  const key = rawKey.trim();
  if (
    key.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[\x21-\x7e]+$/.test(key)
  ) {
    throw new InvalidVoiceTtsIdempotencyKeyError();
  }
  return key;
}

export async function hashVoiceTtsIdempotencyKey(key: string): Promise<string> {
  return await sha256(`voice-tts-key-v1\0${key}`);
}

export async function buildCanonicalVoiceTtsRequestHash(
  request: CanonicalVoiceTtsRequest,
): Promise<string> {
  return await sha256(
    JSON.stringify([
      "voice-tts-request-v1",
      request.text,
      request.provider,
      request.voiceId,
      request.modelId,
      request.format,
      request.affiliateCode,
    ]),
  );
}

function privateResultKey(operation: VoiceTtsOperation): string {
  return `${PRIVATE_RESULT_PREFIX}/${operation.organization_id}/${operation.id}.audio`;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function readResult(
  bucket: RuntimeR2Bucket,
  operation: VoiceTtsOperation,
): Promise<StoredVoiceTtsResult> {
  if (!operation.result_key || !operation.result_content_type || !operation.result_headers) {
    throw new Error("Completed TTS operation is missing result metadata");
  }
  const object = await bucket.get(operation.result_key);
  if (!object?.arrayBuffer) {
    throw new Error("Completed TTS operation audio is unavailable");
  }
  return {
    bytes: new Uint8Array(await object.arrayBuffer()),
    contentType: operation.result_content_type,
    headers: operation.result_headers,
  };
}

async function existingClaimResult(params: {
  bucket: RuntimeR2Bucket;
  operation: VoiceTtsOperation;
  requestHash: string;
  keyHashPrefix: string;
}): Promise<VoiceTtsOperationClaim> {
  const { bucket, operation, requestHash, keyHashPrefix } = params;
  if (operation.request_hash !== requestHash) {
    return { kind: "conflict", operation, keyHashPrefix };
  }
  if (operation.status === "completed") {
    return {
      kind: "completed",
      operation,
      keyHashPrefix,
      result: await readResult(bucket, operation),
    };
  }
  if (operation.status === "failed") {
    if (!operation.failure_status || !operation.failure_body) {
      throw new Error("Failed TTS operation is missing failure metadata");
    }
    return {
      kind: "failed",
      operation,
      keyHashPrefix,
      status: operation.failure_status,
      body: operation.failure_body,
    };
  }
  return { kind: "pending", operation, keyHashPrefix };
}

export class VoiceTtsOperationsService {
  async claim(params: {
    bucket: RuntimeR2Bucket;
    organizationId: string;
    idempotencyKey: string;
    requestHash: string;
    now?: Date;
  }): Promise<VoiceTtsOperationClaim> {
    const now = params.now ?? new Date();
    const keyHash = await hashVoiceTtsIdempotencyKey(params.idempotencyKey);
    const keyHashPrefix = keyHash.slice(0, 12);
    const [created] = await dbWrite
      .insert(voiceTtsOperations)
      .values({
        organization_id: params.organizationId,
        idempotency_key_hash: keyHash,
        request_hash: params.requestHash,
        expires_at: new Date(now.getTime() + OPERATION_TTL_MS),
      })
      .onConflictDoNothing({
        target: [voiceTtsOperations.organization_id, voiceTtsOperations.idempotency_key_hash],
      })
      .returning();

    if (created) {
      return { kind: "claimed", operation: created, keyHashPrefix };
    }

    const [existing] = await dbWrite
      .select()
      .from(voiceTtsOperations)
      .where(
        and(
          eq(voiceTtsOperations.organization_id, params.organizationId),
          eq(voiceTtsOperations.idempotency_key_hash, keyHash),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error("TTS idempotency claim winner is unavailable");
    }

    if (existing.expires_at <= now) {
      if (existing.result_key) {
        await params.bucket.delete(existing.result_key);
      }
      await dbWrite
        .delete(voiceTtsOperations)
        .where(
          and(eq(voiceTtsOperations.id, existing.id), lte(voiceTtsOperations.expires_at, now)),
        );
      return await this.claim({ ...params, now });
    }

    return await existingClaimResult({
      bucket: params.bucket,
      operation: existing,
      requestHash: params.requestHash,
      keyHashPrefix,
    });
  }

  async waitForTerminal(params: {
    bucket: RuntimeR2Bucket;
    operation: VoiceTtsOperation;
    requestHash: string;
    keyHashPrefix: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<VoiceTtsOperationClaim> {
    const deadline = Date.now() + (params.timeoutMs ?? 25_000);
    const pollIntervalMs = params.pollIntervalMs ?? 150;
    while (Date.now() < deadline && !params.signal?.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      const [operation] = await dbWrite
        .select()
        .from(voiceTtsOperations)
        .where(eq(voiceTtsOperations.id, params.operation.id))
        .limit(1);
      if (!operation) {
        throw new Error("Pending TTS operation disappeared during replay");
      }
      const result = await existingClaimResult({
        bucket: params.bucket,
        operation,
        requestHash: params.requestHash,
        keyHashPrefix: params.keyHashPrefix,
      });
      if (result.kind !== "pending") return result;
    }
    return {
      kind: "pending",
      operation: params.operation,
      keyHashPrefix: params.keyHashPrefix,
    };
  }

  async attachReservation(operationId: string, reservationTransactionId: string): Promise<void> {
    const [updated] = await dbWrite
      .update(voiceTtsOperations)
      .set({
        reservation_transaction_id: reservationTransactionId,
        updated_at: new Date(),
      })
      .where(and(eq(voiceTtsOperations.id, operationId), eq(voiceTtsOperations.status, "pending")))
      .returning({ id: voiceTtsOperations.id });
    if (!updated) {
      throw new Error("Pending TTS operation rejected its credit reservation");
    }
  }

  async stageResult(params: {
    bucket: RuntimeR2Bucket;
    operation: VoiceTtsOperation;
    result: StoredVoiceTtsResult;
  }): Promise<void> {
    if (
      params.result.bytes.byteLength === 0 ||
      params.result.bytes.byteLength > MAX_REPLAY_AUDIO_BYTES
    ) {
      throw new Error("TTS replay audio size is outside the supported range");
    }
    const resultKey = privateResultKey(params.operation);
    await params.bucket.put(resultKey, copyArrayBuffer(params.result.bytes), {
      httpMetadata: { contentType: params.result.contentType },
    });
    try {
      const [updated] = await dbWrite
        .update(voiceTtsOperations)
        .set({
          result_key: resultKey,
          result_content_type: params.result.contentType,
          result_headers: params.result.headers,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(voiceTtsOperations.id, params.operation.id),
            eq(voiceTtsOperations.status, "pending"),
          ),
        )
        .returning({ id: voiceTtsOperations.id });
      if (!updated) {
        throw new Error("Pending TTS operation rejected its staged result");
      }
    } catch (error) {
      try {
        await params.bucket.delete(resultKey);
      } catch (deleteError) {
        // error-policy:J6 best-effort teardown of an unreferenced private blob.
        logger.warn("[VoiceTtsOperations] Failed to delete unreferenced result", {
          operationId: params.operation.id,
          errorType: deleteError instanceof Error ? deleteError.name : "unknown",
        });
      }
      throw error;
    }
  }

  async complete(params: { operationId: string; usageRecordId?: string }): Promise<void> {
    const [updated] = await dbWrite
      .update(voiceTtsOperations)
      .set({
        status: "completed",
        ...(params.usageRecordId && { usage_record_id: params.usageRecordId }),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(voiceTtsOperations.id, params.operationId),
          eq(voiceTtsOperations.status, "pending"),
          isNotNull(voiceTtsOperations.result_key),
        ),
      )
      .returning({
        id: voiceTtsOperations.id,
        resultKey: voiceTtsOperations.result_key,
      });
    if (!updated) {
      throw new Error("TTS operation cannot complete without staged audio");
    }
  }

  async fail(params: {
    bucket: RuntimeR2Bucket;
    operationId: string;
    status: number;
    body: Record<string, unknown>;
  }): Promise<void> {
    const [updated] = await dbWrite
      .update(voiceTtsOperations)
      .set({
        status: "failed",
        failure_status: params.status,
        failure_body: params.body,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(voiceTtsOperations.id, params.operationId),
          eq(voiceTtsOperations.status, "pending"),
        ),
      )
      .returning({ resultKey: voiceTtsOperations.result_key });
    if (!updated) {
      throw new Error("Pending TTS operation rejected its failure state");
    }
    if (updated.resultKey) {
      try {
        await params.bucket.delete(updated.resultKey);
      } catch (error) {
        // error-policy:J6 failure state is authoritative; orphan cleanup retries later.
        logger.warn("[VoiceTtsOperations] Failed to delete failed result", {
          operationId: params.operationId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  async cleanupExpired(bucket: RuntimeR2Bucket, now = new Date()): Promise<number> {
    const expired = await dbWrite
      .select({ id: voiceTtsOperations.id, resultKey: voiceTtsOperations.result_key })
      .from(voiceTtsOperations)
      .where(lte(voiceTtsOperations.expires_at, now));
    let deleted = 0;
    for (const operation of expired) {
      if (operation.resultKey) {
        try {
          await bucket.delete(operation.resultKey);
        } catch (error) {
          // error-policy:J6 cleanup is retried on the next scheduled sweep.
          logger.warn("[VoiceTtsOperations] Expired result cleanup failed", {
            operationId: operation.id,
            errorType: error instanceof Error ? error.name : "unknown",
          });
          continue;
        }
      }
      const rows = await dbWrite
        .delete(voiceTtsOperations)
        .where(
          and(eq(voiceTtsOperations.id, operation.id), lte(voiceTtsOperations.expires_at, now)),
        )
        .returning({ id: voiceTtsOperations.id });
      deleted += rows.length;
    }
    return deleted;
  }
}

export const voiceTtsOperationsService = new VoiceTtsOperationsService();
