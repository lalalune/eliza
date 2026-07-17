/**
 * Invalidates process-local credential facades and capabilities after their
 * persistent stores are destroyed. The reset route invokes this inside its
 * exclusive credential-state transaction so no retired token or vault facade
 * can cross into the freshly initialized agent.
 */

import { resetInternalWakeStateForAgentReset } from "./internal-routes";
import { resetSecretsManagerRouteStateForAgentReset } from "./secrets-manager-routes";
import { resetSensitiveRequestsForAgentReset } from "./sensitive-request-routes";
import { resetWalletExportGuardForAgentReset } from "./server-wallet-trade";

export function resetVolatileCredentialStateForAgentReset(): void {
  resetInternalWakeStateForAgentReset();
  resetSecretsManagerRouteStateForAgentReset();
  resetSensitiveRequestsForAgentReset();
  resetWalletExportGuardForAgentReset();
}
