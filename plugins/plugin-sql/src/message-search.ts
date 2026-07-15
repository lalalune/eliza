/**
 * Installs and queries the Postgres search objects for corpus-wide chat search
 * (#13534): immutable text folding, a materialized message document, and FTS
 * plus trigram GIN indexes over `memories` rows of type `messages`.
 *
 * The fixed `translate()` fold replaces mutable, PGlite-absent `unaccent`, so it
 * is safe in generated columns and expression indexes. Materializing attachment
 * parsing and folding on write avoids recomputing them across the corpus when a
 * fuzzy fallback misses the FTS index.
 *
 * Operator-bearing websearch queries use FTS only because literal and trigram
 * fallbacks cannot preserve phrase, negation, or OR semantics. `pg_trgm` remains
 * optional: without it, whole-word correctness stays indexed while substring
 * matching uses the inexpensive stored document.
 */
import {
  type AccessContext,
  logger,
  type Memory,
  type MessageSearchHit,
  type UUID,
} from "@elizaos/core";
import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { memoryTable } from "./schema";
import type { DrizzleDatabase } from "./types";

export const FTS_CONFIG = "english";
export const MESSAGE_SEARCH_TABLE_TYPE = "messages";

// Accent-folding map: each accented Latin letter → its ASCII base. `from` and
// `to` are equal length; the three trailing chars in `from` (straight/curly
// apostrophe, backtick) have no `to` counterpart and are therefore deleted by
// translate() so "don't" folds to "dont".
const ACCENT_FROM = "àáâãäåāăąèéêëēĕėęěìíîïĩīĭįòóôõöøōŏőùúûüũūŭůűñçćčšžýÿ";
const ACCENT_TO = "aaaaaaaaaeeeeeeeeeiiiiiiiiooooooooouuuuuuuuuncccszyy";
const STRIP_CHARS = "'’`";

/** SQL string literal for `translate`'s `from` set, single-quotes doubled. */
const FOLD_FROM_LITERAL = (ACCENT_FROM + STRIP_CHARS).replace(/'/g, "''");

export interface StructuredMessageSearchParams {
  roomIds: UUID[];
  query: string;
  tableName?: string;
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  accessContext?: AccessContext;
}

interface MessageSearchRow {
  id: string;
  createdAt: Date;
  content: unknown;
  entityId: string | null;
  agentId: string;
  roomId: string | null;
  worldId: string | null;
  unique: boolean;
  metadata: unknown;
  ftsRank: unknown;
}

/** Whether relaxing this query to literal/fuzzy matching would change its meaning. */
export function usesStructuredWebsearchSyntax(value: string): boolean {
  return value.includes('"') || /(^|\s)-(?=\S)/.test(value) || /(^|\s)or(?=\s|$)/i.test(value);
}

function isMessageSearchObjectsMissing(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const layer = current as { code?: unknown; message?: unknown; cause?: unknown };
    const message = typeof layer.message === "string" ? layer.message : "";
    if (
      (layer.code === "42703" || layer.code === "42883" || /does not exist/i.test(message)) &&
      /message_search_document|eliza_search_fold/i.test(message)
    ) {
      return true;
    }
    current = layer.cause;
  }
  return false;
}

function mapMessageSearchRows(rows: MessageSearchRow[]): MessageSearchHit[] {
  return rows.map((row) => ({
    memory: {
      id: row.id as UUID,
      createdAt: row.createdAt.getTime(),
      content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
      entityId: row.entityId as UUID,
      agentId: row.agentId as UUID,
      roomId: row.roomId as UUID,
      worldId: (row.worldId ?? undefined) as UUID | undefined,
      unique: row.unique,
      metadata: row.metadata,
    } as Memory,
    ftsRank: Number(row.ftsRank),
    trigramSimilarity: 0,
  }));
}

async function executeStructuredMessageSearch(
  db: DrizzleDatabase,
  agentId: UUID,
  params: StructuredMessageSearchParams,
  document: SQL,
  foldedQuery: SQL
): Promise<MessageSearchHit[]> {
  const tableName = params.tableName ?? MESSAGE_SEARCH_TABLE_TYPE;
  const tsvector = sql`to_tsvector('${sql.raw(FTS_CONFIG)}', ${document})`;
  const tsquery = sql`websearch_to_tsquery('${sql.raw(FTS_CONFIG)}', ${foldedQuery})`;
  const ftsRank = sql<number>`ts_rank_cd(${tsvector}, ${tsquery})`;
  const conditions: SQL[] = [
    eq(memoryTable.type, tableName),
    eq(memoryTable.agentId, agentId),
    inArray(memoryTable.roomId, params.roomIds),
    sql`${tsvector} @@ ${tsquery}`,
  ];
  if (typeof params.since === "number") {
    conditions.push(gte(memoryTable.createdAt, new Date(params.since)));
  }
  if (typeof params.until === "number") {
    conditions.push(lte(memoryTable.createdAt, new Date(params.until)));
  }

  const rows = await db
    .select({
      id: memoryTable.id,
      createdAt: memoryTable.createdAt,
      content: memoryTable.content,
      entityId: memoryTable.entityId,
      agentId: memoryTable.agentId,
      roomId: memoryTable.roomId,
      worldId: memoryTable.worldId,
      unique: memoryTable.unique,
      metadata: memoryTable.metadata,
      ftsRank: ftsRank.as("fts_rank"),
    })
    .from(memoryTable)
    .where(and(...conditions))
    .orderBy(sql`fts_rank DESC`, desc(memoryTable.createdAt), asc(memoryTable.id))
    .limit(params.limit ?? 20)
    .offset(params.offset ?? 0);
  return mapMessageSearchRows(rows);
}

/**
 * Runs operator-bearing queries through full-text search only. If production
 * has intentionally deferred the generated-column/index migration, the same
 * fold and document expression is evaluated inline so correctness survives at
 * sequential-scan cost until operators install the search objects.
 */
export async function searchStructuredMessages(
  db: DrizzleDatabase,
  agentId: UUID,
  params: StructuredMessageSearchParams
): Promise<MessageSearchHit[]> {
  if (params.roomIds.length === 0) return [];

  try {
    return await executeStructuredMessageSearch(
      db,
      agentId,
      params,
      sql`message_search_document`,
      sql`eliza_search_fold(${params.query})`
    );
  } catch (error) {
    if (!isMessageSearchObjectsMissing(error)) throw error;
    // error-policy:J4 production Postgres may defer the heavy search-object
    // migration; this explicit sequential FTS path preserves operator meaning.
    logger.warn(
      {
        src: "plugin:sql",
        error: error instanceof Error ? error.message : String(error),
      },
      "[MessageSearch] search objects are missing; using sequential structured search"
    );
  }

  const inlineDocument = sql`translate(lower(
    coalesce(${memoryTable.content}->>'text', '')
    || ' ' ||
    coalesce((
      SELECT string_agg(coalesce(attachment->>'title', '') || ' ' || coalesce(attachment->>'url', ''), ' ')
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${memoryTable.content}->'attachments') = 'array'
             THEN ${memoryTable.content}->'attachments' ELSE '[]'::jsonb END
      ) AS attachment
    ), '')
  ), '${sql.raw(FOLD_FROM_LITERAL)}', '${sql.raw(ACCENT_TO)}')`;
  const inlineQuery = sql`translate(lower(${params.query}), '${sql.raw(FOLD_FROM_LITERAL)}', '${sql.raw(ACCENT_TO)}')`;
  return await executeStructuredMessageSearch(db, agentId, params, inlineDocument, inlineQuery);
}

/**
 * Create (idempotently) the folding/document functions and the FTS + trigram
 * indexes. Safe to run on every startup after migrations. Returns whether the
 * `pg_trgm` trigram index is available so the query layer can decide whether to
 * emit `similarity()` / gin_trgm_ops-accelerated `LIKE`.
 */
export async function applyMessageSearchObjects(
  db: DrizzleDatabase
): Promise<{ trigramAvailable: boolean }> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION eliza_search_fold(t text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fold$
      SELECT translate(lower(t), '${sql.raw(FOLD_FROM_LITERAL)}', '${sql.raw(ACCENT_TO)}')
    $fold$;
  `);

  // The searchable document: message body plus attachment titles/URLs, folded.
  // The `translate(lower(...))` fold is inlined here rather than calling
  // `eliza_search_fold` because a nested user-function call cannot be resolved
  // when Postgres inlines this function into an expression index (it re-parses
  // the body with a restricted search_path). The map is kept identical to
  // `eliza_search_fold` by sourcing both from the same constants.
  // `jsonb_array_elements` is guarded so a non-array `attachments` value cannot
  // raise inside the immutable function (which would break the expression index).
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION eliza_message_search_document(content jsonb)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $doc$
      SELECT translate(lower(
        coalesce(content->>'text', '')
        || ' ' ||
        coalesce((
          SELECT string_agg(coalesce(a->>'title', '') || ' ' || coalesce(a->>'url', ''), ' ')
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(content->'attachments') = 'array'
                 THEN content->'attachments' ELSE '[]'::jsonb END
          ) AS a
        ), '')
      ), '${sql.raw(FOLD_FROM_LITERAL)}', '${sql.raw(ACCENT_TO)}')
    $doc$;
  `);

  // Escaped `%folded%` LIKE pattern so user `%`/`_`/`\` match literally.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION eliza_search_like_pattern(t text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $like$
      SELECT '%' || replace(replace(replace(eliza_search_fold(t), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
    $like$;
  `);

  // Materialize the folded document once per row. `CASE WHEN type='messages'`
  // keeps the stored text off every non-message memory (facts, embeddings, …) so
  // the column only costs storage for chat rows. Generated STORED so the value
  // is computed on write and read straight from the heap at query time.
  await db.execute(sql`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS message_search_document text
    GENERATED ALWAYS AS (
      CASE WHEN type = '${sql.raw(MESSAGE_SEARCH_TABLE_TYPE)}'
           THEN eliza_message_search_document(content) ELSE NULL END
    ) STORED;
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_memories_message_fts ON memories
    USING gin (to_tsvector('${sql.raw(FTS_CONFIG)}', message_search_document))
    WHERE type = '${sql.raw(MESSAGE_SEARCH_TABLE_TYPE)}';
  `);

  let trigramAvailable = false;
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_memories_message_trgm ON memories
      USING gin (message_search_document gin_trgm_ops)
      WHERE type = '${sql.raw(MESSAGE_SEARCH_TABLE_TYPE)}';
    `);
    trigramAvailable = true;
  } catch (error) {
    // error-policy:J4 pg_trgm is an optional accelerator — degrade to FTS +
    // unindexed LIKE (correct, just slower for partial-word/substring recall).
    logger.warn(
      {
        src: "plugin:sql",
        error: error instanceof Error ? error.message : String(error),
      },
      "[MessageSearch] pg_trgm unavailable; trigram acceleration disabled (FTS still active)"
    );
  }

  logger.info(
    { src: "plugin:sql", trigramAvailable },
    "[MessageSearch] full-text search objects applied"
  );
  return { trigramAvailable };
}
