/** Reaps unusable sandbox credentials after durable inference revocation. */
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";

/** Returns the number of database rows atomically revoked before the cutoff. */
export async function sweepStrandedAgentKeys(olderThan: Date): Promise<number> {
  const stranded = await apiKeysService.revokeStrandedAgentKeys(olderThan);

  if (stranded.length > 0) {
    logger.warn("[ApiKeys] Swept stranded agent-sandbox keys", {
      revoked: stranded.length,
      olderThan: olderThan.toISOString(),
    });
  }
  return stranded.length;
}

/** Injectable route boundary retained as an object so cron wiring tests can spy without module mocks. */
export const strandedAgentKeySweeper = { sweep: sweepStrandedAgentKeys };
