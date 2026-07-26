/**
 * Vault domain methods — saved-login autofill for the in-app browser.
 *
 * Mirrors the wallet-shim contract: the in-tab preload sends
 * `__elizaVaultAutofillRequest` to the host, the host calls these
 * methods, then replies via `tag.executeJavascript("window.__elizaVaultReply(...)")`.
 *
 * The list endpoint aggregates entries from every signed-in backend:
 * in-house vault, 1Password, and Bitwarden. Each entry carries a
 * `source` + `identifier` pair so callers can reveal credentials
 * uniformly via `revealSavedLogin(source, identifier)`.
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.listSavedLogins = async function (domain) {
    const path = domain
        ? `/api/secrets/logins?domain=${encodeURIComponent(domain)}`
        : "/api/secrets/logins";
    const res = await this.fetch(path);
    return { logins: res.logins, failures: res.failures };
};
ElizaClient.prototype.revealSavedLogin = async function (source, identifier) {
    const params = new URLSearchParams({ source, identifier });
    const path = `/api/secrets/logins/reveal?${params.toString()}`;
    const res = await this.fetch(path);
    return res.login;
};
ElizaClient.prototype.saveSavedLogin = async function (input) {
    await this.fetch("/api/secrets/logins", {
        method: "POST",
        body: JSON.stringify(input),
    });
};
ElizaClient.prototype.deleteSavedLogin = async function (domain, username) {
    const path = `/api/secrets/logins/${encodeURIComponent(domain)}/${encodeURIComponent(username)}`;
    await this.fetch(path, { method: "DELETE" });
};
ElizaClient.prototype.getAutofillAllowed = async function (domain) {
    const path = `/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`;
    const res = await this.fetch(path);
    return res.allowed;
};
ElizaClient.prototype.setAutofillAllowed = async function (domain, allowed) {
    const path = `/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`;
    await this.fetch(path, {
        method: "PUT",
        body: JSON.stringify({ allowed }),
    });
};
