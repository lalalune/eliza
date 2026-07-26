/**
 * Exercises the TTS operation ledger against real PGlite and an in-memory R2
 * boundary, including concurrent claims, payload conflicts, and byte replay.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
setDefaultTimeout(60_000);

const { closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import(
  "../../db/client"
);
const {
  buildCanonicalVoiceTtsRequestHash,
  hashVoiceTtsIdempotencyKey,
  InvalidVoiceTtsIdempotencyKeyError,
  normalizeVoiceTtsIdempotencyKey,
  voiceTtsOperationsService,
} = await import("./voice-tts-operations");

class MemoryR2Bucket implements RuntimeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob | null) {
    if (value === null) {
      this.objects.set(key, new Uint8Array());
      return;
    }
    if (typeof value === "string") {
      this.objects.set(key, new TextEncoder().encode(value));
      return;
    }
    if (value instanceof Blob) {
      this.objects.set(key, new Uint8Array(await value.arrayBuffer()));
      return;
    }
    if (value instanceof ArrayBuffer) {
      this.objects.set(key, new Uint8Array(value.slice(0)));
      return;
    }
    this.objects.set(
      key,
      new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)),
    );
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

const bucket = new MemoryR2Bucket();
const orgA = "10000000-0000-4000-8000-000000000001";
const orgB = "10000000-0000-4000-8000-000000000002";

async function requestHash(text: string): Promise<string> {
  return await buildCanonicalVoiceTtsRequestHash({
    text,
    provider: "elevenlabs",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    modelId: "eleven_flash_v2_5",
    format: "mp3",
    affiliateCode: null,
  });
}

beforeAll(async () => {
  const client = getPgliteClientForTests();
  await client.exec(`
    CREATE TABLE voice_tts_operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      reservation_transaction_id uuid,
      usage_record_id uuid,
      result_key text,
      result_content_type text,
      result_headers jsonb,
      failure_status integer,
      failure_body jsonb,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT voice_tts_operations_tenant_key_idx
        UNIQUE (organization_id, idempotency_key_hash)
    );
    CREATE INDEX voice_tts_operations_expires_idx
      ON voice_tts_operations (expires_at);
    CREATE INDEX voice_tts_operations_status_idx
      ON voice_tts_operations (status);
  `);
});

beforeEach(async () => {
  await getPgliteClientForTests().exec("TRUNCATE voice_tts_operations;");
  bucket.objects.clear();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("voice TTS operation ledger", () => {
  test("validates and irreversibly hashes caller keys", async () => {
    expect(normalizeVoiceTtsIdempotencyKey(" utterance-123 ")).toBe("utterance-123");
    expect(() => normalizeVoiceTtsIdempotencyKey("short")).toThrow(
      InvalidVoiceTtsIdempotencyKeyError,
    );
    const keyHash = await hashVoiceTtsIdempotencyKey("utterance-123");
    expect(keyHash).toHaveLength(64);
    expect(keyHash).not.toContain("utterance-123");
  });

  test("collapses concurrent tenant claims and rejects payload drift", async () => {
    const hash = await requestHash("Speak once.");
    const claims = await Promise.all([
      voiceTtsOperationsService.claim({
        bucket,
        organizationId: orgA,
        idempotencyKey: "utterance-123",
        requestHash: hash,
      }),
      voiceTtsOperationsService.claim({
        bucket,
        organizationId: orgA,
        idempotencyKey: "utterance-123",
        requestHash: hash,
      }),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(["claimed", "pending"]);

    const conflict = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-123",
      requestHash: await requestHash("Charge this different payload."),
    });
    expect(conflict.kind).toBe("conflict");

    const otherTenant = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgB,
      idempotencyKey: "utterance-123",
      requestHash: hash,
    });
    expect(otherTenant.kind).toBe("claimed");
  });

  test("persists exact audio and replays it without another claim", async () => {
    const hash = await requestHash("Persist this.");
    const claimed = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-replay",
      requestHash: hash,
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("claim did not win");

    const bytes = new Uint8Array([73, 68, 51, 4, 5, 6]);
    await voiceTtsOperationsService.stageResult({
      bucket,
      operation: claimed.operation,
      result: {
        bytes,
        contentType: "audio/mpeg",
        headers: { "X-Eliza-TTS-Provider": "elevenlabs" },
      },
    });
    await voiceTtsOperationsService.complete({
      operationId: claimed.operation.id,
    });

    const replay = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-replay",
      requestHash: hash,
    });
    expect(replay.kind).toBe("completed");
    if (replay.kind !== "completed") throw new Error("replay was not complete");
    expect(replay.result.bytes).toEqual(bytes);
    expect(replay.result.contentType).toBe("audio/mpeg");
  });

  test("keeps incomplete claims pending and removes expired staged audio", async () => {
    const hash = await requestHash("Expire this.");
    const claimed = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-expiry",
      requestHash: hash,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("claim did not win");

    await expect(
      voiceTtsOperationsService.complete({ operationId: claimed.operation.id }),
    ).rejects.toThrow("cannot complete without staged audio");
    const stillPending = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-expiry",
      requestHash: hash,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(stillPending.kind).toBe("pending");

    await voiceTtsOperationsService.stageResult({
      bucket,
      operation: claimed.operation,
      result: {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "audio/mpeg",
        headers: {},
      },
    });
    expect(bucket.objects.size).toBe(1);

    const reclaimed = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-expiry",
      requestHash: hash,
      now: new Date("2026-01-09T00:00:00.000Z"),
    });
    expect(reclaimed.kind).toBe("claimed");
    expect(bucket.objects.size).toBe(0);
  });

  test("stores authoritative failures and cleans expired private results", async () => {
    const hash = await requestHash("Fail this.");
    const claimed = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-failure",
      requestHash: hash,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("claim did not win");

    await voiceTtsOperationsService.fail({
      bucket,
      operationId: claimed.operation.id,
      status: 402,
      body: { error: "Insufficient credits" },
    });
    const replay = await voiceTtsOperationsService.claim({
      bucket,
      organizationId: orgA,
      idempotencyKey: "utterance-failure",
      requestHash: hash,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(replay).toMatchObject({
      kind: "failed",
      status: 402,
      body: { error: "Insufficient credits" },
    });

    expect(
      await voiceTtsOperationsService.cleanupExpired(bucket, new Date("2026-01-09T00:00:00.000Z")),
    ).toBe(1);
  });
});
