/**
 * Credential-bearing renderer keys and the generation fence shared by writers
 * and destructive reset. Async authentication work captures a generation
 * before it starts; reset advances that generation before erasing state, so a
 * late response cannot restore credentials from the discarded session.
 */

export const CLOUD_PAIR_SESSION_STORAGE_KEY = "eliza:cloud-pair:api-token";
export const BOOTSTRAP_SESSION_STORAGE_KEY = "eliza_session";
export const ANONYMOUS_CLOUD_SESSION_STORAGE_KEY = "eliza-anon-session-token";

export type RendererCredentialWriteGeneration = number;

let rendererCredentialGeneration = 0;
let rendererCredentialResetInProgress = false;

export class RendererCredentialResetError extends Error {
  constructor() {
    super("Credential write was cancelled by destructive reset");
    this.name = "RendererCredentialResetError";
  }
}

/** Captures the session generation that an async credential write belongs to. */
export function captureRendererCredentialWriteGeneration(): RendererCredentialWriteGeneration {
  return rendererCredentialGeneration;
}

export function isRendererCredentialResetInProgress(): boolean {
  return rendererCredentialResetInProgress;
}

export function isRendererCredentialWriteAllowed(
  generation: RendererCredentialWriteGeneration,
): boolean {
  return (
    !rendererCredentialResetInProgress &&
    generation === rendererCredentialGeneration
  );
}

export function assertRendererCredentialWriteAllowed(
  generation: RendererCredentialWriteGeneration,
): void {
  if (!isRendererCredentialWriteAllowed(generation)) {
    throw new RendererCredentialResetError();
  }
}

/** Invalidates old async writers before reset begins removing credentials. */
export function beginRendererCredentialReset(): RendererCredentialWriteGeneration {
  if (rendererCredentialResetInProgress) {
    throw new Error("Renderer credential reset is already in progress");
  }
  rendererCredentialGeneration += 1;
  rendererCredentialResetInProgress = true;
  return rendererCredentialGeneration;
}

/** Releases the write barrier after both browser and native verification end. */
export function finishRendererCredentialReset(
  generation: RendererCredentialWriteGeneration,
): void {
  if (
    !rendererCredentialResetInProgress ||
    generation !== rendererCredentialGeneration
  ) {
    throw new Error("Renderer credential reset generation is inconsistent");
  }
  rendererCredentialResetInProgress = false;
}
