/**
 * Classifies HTTP requests that may persist credentials or configuration so
 * both standalone and embedded servers keep those requests inside the reset
 * barrier without making long-lived chat streams block reset.
 */

function isPathWithin(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** True when the request can create, refresh, or delete credential state. */
export function requestMayMutateCredentialState(
  method: string | undefined,
  pathname: string,
): boolean {
  if (pathname === "/api/agent/reset") return false;

  const normalizedMethod = (method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
    if (
      pathname === "/v1/chat/completions" ||
      /^\/api\/agents\/[^/]+\/message\/?$/.test(pathname) ||
      isPathWithin(pathname, "/api/chat")
    ) {
      return false;
    }
    return true;
  }

  return (
    isPathWithin(pathname, "/api/auth") ||
    isPathWithin(pathname, "/api/accounts") ||
    isPathWithin(pathname, "/api/embed/auth") ||
    isPathWithin(pathname, "/api/secrets") ||
    isPathWithin(pathname, "/internal/account-pool/v1") ||
    isPathWithin(pathname, "/api/setup/telegram-account") ||
    pathname === "/api/first-run/status" ||
    pathname === "/api/wallet/keys" ||
    (normalizedMethod === "GET" &&
      /^\/api\/connectors\/[^/]+\/oauth\/callback\/?$/.test(pathname)) ||
    (normalizedMethod === "GET" &&
      /^\/api\/lifeops\/connectors\/health\/[^/]+\/callback\/?$/.test(
        pathname,
      )) ||
    (normalizedMethod === "GET" &&
      (isPathWithin(pathname, "/api/discord/guilds") ||
        isPathWithin(pathname, "/api/discord/channels"))) ||
    isPathWithin(pathname, "/api/apps/feed") ||
    isPathWithin(pathname, "/api/subscription")
  );
}
