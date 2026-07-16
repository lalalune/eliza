/**
 * Gate for shell data loaders that hit protected (auth-required) agent API
 * routes on mount.
 *
 * Protected work begins only after `/api/auth/me` establishes the caller. A
 * trusted loopback is reported as an authenticated local session, while remote
 * password/session boundaries remain unauthenticated until login. This server-
 * resolved distinction avoids origin heuristics that mistake authenticated
 * self-hosted agents for open local agents. Consumers:
 * `notifications-boot`, `useWeather`, `useRuntimeMode`, `useSlashCommandController`.
 */

import { useIsAuthenticated } from "./useAuthStatus";

/**
 * Pure decision behind {@link useProtectedAgentProbesEnabled}.
 */
export function protectedAgentProbesEnabled(authenticated: boolean): boolean {
  return authenticated;
}

export function useProtectedAgentProbesEnabled(): boolean {
  return protectedAgentProbesEnabled(useIsAuthenticated());
}
