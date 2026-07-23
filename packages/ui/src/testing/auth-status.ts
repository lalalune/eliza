/**
 * Authenticated owner state for isolated UI tests that exercise protected
 * agent loaders without mounting the app-level auth probe.
 */

import { __setAuthStatusForTests } from "../hooks/useAuthStatus";

export function authenticateOwnerForTests(): void {
  __setAuthStatusForTests({
    phase: "authenticated",
    identity: { id: "test-owner", displayName: "Owner", kind: "owner" },
    session: { id: "test-session", kind: "browser", expiresAt: null },
    access: {
      mode: "session",
      passwordConfigured: true,
      ownerConfigured: true,
      role: "OWNER",
    },
  });
}
