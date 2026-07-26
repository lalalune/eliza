/**
 * Orders restrictive anonymous-session persistence behind Durable Object revocation.
 *
 * Conversion and deactivation must linearize at the cache boundary before
 * Postgres can report the session inactive. A failed database mutation may
 * leave an active row temporarily denied, but it can never leave a converted
 * credential usable by the provider-dispatch gate.
 */

import { invalidateAnonymousChatGateByToken } from "./anonymous-chat-admission";

export async function persistAnonymousSessionRestriction<T>(
  sessionToken: string,
  persist: () => Promise<T>,
): Promise<T> {
  await invalidateAnonymousChatGateByToken(sessionToken);
  return await persist();
}
