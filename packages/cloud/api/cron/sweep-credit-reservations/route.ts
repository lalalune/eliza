/**
 * Recovers stranded credit reservations and projects durable affiliate payout
 * intents. Cron authentication keeps both money-repair lanes off public APIs.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { drainAffiliatePayoutOutbox } from "@/lib/services/affiliate-payout-outbox";
import { creditsService } from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

/**
 * Backstop for synchronous credit reservations (#11169): settle reservation
 * debits whose post-response waitUntil reconciliation never ran.
 */
async function handleSweepCreditReservations(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const [stats, affiliatePayouts] = await Promise.all([
      creditsService.sweepStaleReservations(),
      drainAffiliatePayoutOutbox(),
    ]);
    logger.info("[Credits] stale reservation and affiliate payout sweep complete", {
      creditReservations: stats,
      affiliatePayouts,
    });
    return c.json({ success: true, stats, affiliatePayouts });
  } catch (error) {
    // error-policy:J1 cron is the outer transport boundary for both durable
    // recovery lanes; preserve the structured failure response for retry.
    logger.error("[Credits] stale reservation sweep failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleSweepCreditReservations);

export default app;
