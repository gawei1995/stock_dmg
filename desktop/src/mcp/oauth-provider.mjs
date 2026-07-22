import { randomBytes } from "node:crypto";

/**
 * Persistent OAuth 2.1 provider for the MCP TypeScript SDK.
 * Secrets are stored only through EncryptedStore (Electron safeStorage).
 */
export class DesktopOAuthProvider {
  constructor({ redirectUrl, store, onRedirect, keyPrefix = "longbridge" }) {
    this._redirectUrl = redirectUrl;
    this.store = store;
    this.onRedirect = onRedirect;
    this.keyPrefix = keyPrefix;
    this._state = randomBytes(24).toString("base64url");
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: "Trading Cockpit Desktop",
      client_uri: "https://open.longbridge.com/docs/mcp",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "6",
    };
  }

  state() {
    return this._state;
  }

  validateState(value) {
    return Boolean(value) && value === this._state;
  }

  async clientInformation() {
    return this.store.get(this.#key("clientInformation"));
  }

  async saveClientInformation(value) {
    await this.store.set(this.#key("clientInformation"), value);
  }

  async tokens() {
    return this.store.get(this.#key("tokens"));
  }

  async saveTokens(value) {
    const previous = await this.tokens();
    await this.store.set(this.#key("tokens"), {
      ...value,
      refresh_token: value.refresh_token ?? previous?.refresh_token,
    });
  }

  async redirectToAuthorization(url) {
    const host = url.hostname;
    const scopes = new Set((url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean));
    const allowedHost = host === "openapi.longbridge.com" || host === "openapi.longbridge.cn";
    if (url.protocol !== "https:" || !allowedHost) {
      throw new Error("Rejected an unexpected Longbridge authorization URL.");
    }
    if (scopes.size !== 1 || !scopes.has("6")) {
      throw new Error("Rejected a Longbridge authorization request outside account.read scope 6.");
    }
    await this.onRedirect(url);
  }

  async saveCodeVerifier(value) {
    await this.store.set(this.#key("codeVerifier"), value);
  }

  async codeVerifier() {
    const value = await this.store.get(this.#key("codeVerifier"));
    if (!value) throw new Error("Longbridge PKCE verifier is missing.");
    return value;
  }

  async saveDiscoveryState(value) {
    await this.store.set(this.#key("discoveryState"), value);
  }

  async discoveryState() {
    return this.store.get(this.#key("discoveryState"));
  }

  async invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") {
      await this.store.delete(this.#key("tokens"));
    }
    if (scope === "all" || scope === "client") {
      await this.store.delete(this.#key("clientInformation"));
    }
    if (scope === "all" || scope === "verifier") {
      await this.store.delete(this.#key("codeVerifier"));
    }
    if (scope === "all" || scope === "discovery") {
      await this.store.delete(this.#key("discoveryState"));
    }
  }

  #key(name) {
    return `${this.keyPrefix}:${name}`;
  }
}
