/**
 * Gate for shell data loaders that hit protected (auth-required) agent API
 * routes on mount.
 *
 * Protected routes are session-gated on every origin. A self-hosted/remote
 * agent can require an owner password just as a Cloud host can; inferring
 * authorization from `localhost` or an arbitrary hostname makes fresh login
 * screens issue a burst of 401s and can exhaust the invalid-auth limiter before
 * the owner submits valid credentials. The app-level auth probe is shared, so
 * this gate adds no extra round trip. Consumers:
 * `notifications-boot`, `useWeather`, `useRuntimeMode`, `useSlashCommandController`.
 */

import { useIsAuthenticated } from "./useAuthStatus";

/**
 * Pure decision behind {@link useProtectedAgentProbesEnabled}. `origin` stays
 * in the signature for module-store callers and compatibility, but no origin
 * is itself proof of authorization.
 */
export function protectedAgentProbesEnabled(
  authenticated: boolean,
  _origin: string | null | undefined,
): boolean {
  return authenticated;
}

export function useProtectedAgentProbesEnabled(): boolean {
  const authenticated = useIsAuthenticated();
  return protectedAgentProbesEnabled(
    authenticated,
    typeof window !== "undefined" ? window.location.origin : null,
  );
}
