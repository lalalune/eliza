/**
 * Stable public base-adapter entrypoint with operator-safe message search.
 * Concrete SQL adapters inherit the complete shared persistence contract from
 * `BaseDrizzleAdapterCore`; only queries whose websearch syntax cannot be
 * preserved by literal/trigram fallbacks take the focused FTS-only path.
 */
import type { MessageSearchHit } from "@elizaos/core";
import { BaseDrizzleAdapter as BaseDrizzleAdapterCore } from "./base-adapter-core";
import {
  type StructuredMessageSearchParams,
  searchStructuredMessages,
  usesStructuredWebsearchSyntax,
} from "./message-search";
import type { DrizzleDatabase } from "./types";

export abstract class BaseDrizzleAdapter extends BaseDrizzleAdapterCore {
  override async searchMessages(
    params: StructuredMessageSearchParams
  ): Promise<MessageSearchHit[]> {
    if (!usesStructuredWebsearchSyntax(params.query)) {
      return await super.searchMessages(params);
    }
    return await this.withDatabase(async () =>
      searchStructuredMessages(this.db as DrizzleDatabase, this.agentId, params)
    );
  }
}
