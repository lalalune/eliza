/**
 * Cross-component one-time hand-off for a freshly minted app API key.
 *
 * When an app is created or its key regenerated, the new key is shown exactly
 * once. We stash it in a module-level map keyed by app id so the detail page's
 * Overview tab can reveal it on first mount, then drop it.
 */

import {
  assertRendererCredentialWriteAllowed,
  captureRendererCredentialWriteGeneration,
  type RendererCredentialWriteGeneration,
} from "../../../state/credential-storage-keys";

const oneTimeAppApiKeys = new Map<string, string>();

export function storeOneTimeAppApiKey(
  appId: string,
  apiKey: string,
  generation: RendererCredentialWriteGeneration = captureRendererCredentialWriteGeneration(),
): void {
  if (!appId || !apiKey) return;
  assertRendererCredentialWriteAllowed(generation);
  oneTimeAppApiKeys.set(appId, apiKey);
}

export function consumeOneTimeAppApiKey(appId: string): string | undefined {
  const apiKey = oneTimeAppApiKeys.get(appId);
  if (apiKey) {
    oneTimeAppApiKeys.delete(appId);
  }
  return apiKey;
}

/** Drops every unconsumed API key when the owning agent is reset. */
export function clearOneTimeAppApiKeysForReset(): void {
  oneTimeAppApiKeys.clear();
}
