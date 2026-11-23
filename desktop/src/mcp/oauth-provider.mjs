import { randomBytes } from "node:crypto";

// Longbridge's restricted /v2 surface separates portfolio reads (6) from
// order/execution history reads (10). Keep this explicit instead of following
// every scope advertised by the server: scope 4 can mutate watchlists and
// scope 11 can place/replace/cancel orders.
export const LONGBRIDGE_READ_SCOPE = "6 10";
const REQUIRED_READ_SCOPES = new Set(LONGBRIDGE_READ_SCOPE.split(" "));

/**
 * Persistent OAuth 2.1 provider for the MCP TypeScript SDK.
 * Secrets are stored only through EncryptedStore (Electron safeStorage).
 */
export class DesktopOAuthProvider {
  constructor({
    redirectUrl,
    store,
    onRedirect,
    keyPrefix = "longbridge",
    commitGuard = () => true,
  }) {
    this._redirectUrl = redirectUrl;
    this.store = store;
    this.onRedirect = onRedirect;
    this.keyPrefix = keyPrefix;
    this.commitGuard = typeof commitGuard === "function" ? commitGuard : () => false;
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
      scope: LONGBRIDGE_READ_SCOPE,
    };
  }

  state() {
    return this._state;
  }

  validateState(value) {
    return Boolean(value) && value === this._state;
  }

  async clientInformation() {
    this.#assertCommitAllowed();
    const value = await this.store.get(this.#key("clientInformation"));
    this.#assertCommitAllowed();
    return requireBoundCredentials(value);
  }

  async saveClientInformation(value) {
    this.#assertCommitAllowed();
    requireBoundCredentials(value);
    await this.store.set(this.#key("clientInformation"), value);
  }

  async tokens() {
    this.#assertCommitAllowed();
    const value = await this.store.get(this.#key("tokens"));
    this.#assertCommitAllowed();
    return requireBoundCredentials(value);
  }

  async saveTokens(value) {
    this.#assertCommitAllowed();
    requireBoundCredentials(value);
    const previous = await this.store.get(this.#key("tokens"));
    this.#assertCommitAllowed();
    // A refresh response may omit the refresh token. Never carry one across
    // issuers, or adopt an unstamped token from the pre-1.31 SDK on first use.
    const sameIssuer = validIssuer(previous?.issuer)
      && normalizedIssuer(previous.issuer) === normalizedIssuer(value.issuer);
    await this.store.set(this.#key("tokens"), {
      ...value,
      ...(value.refresh_token == null && sameIssuer && previous.refresh_token != null
        ? { refresh_token: previous.refresh_token } : {}),
    });
  }

  async redirectToAuthorization(url) {
    const host = url.hostname;
    const scopes = new Set((url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean));
    const allowedHost = host === "openapi.longbridge.com";
    if (url.protocol !== "https:" || !allowedHost) {
      throw new Error("Rejected an unexpected Longbridge authorization URL.");
    }
    if (
      scopes.size !== REQUIRED_READ_SCOPES.size
      || [...REQUIRED_READ_SCOPES].some((scope) => !scopes.has(scope))
    ) {
      throw new Error("Rejected a Longbridge authorization request outside account.read + trade.read scopes 6 and 10.");
    }
    await this.onRedirect(url);
  }

  async saveCodeVerifier(value) {
    this.#assertCommitAllowed();
    await this.store.set(this.#key("codeVerifier"), value);
  }

  async codeVerifier() {
    const value = await this.store.get(this.#key("codeVerifier"));
    if (!value) throw new Error("Longbridge PKCE verifier is missing.");
    return value;
  }

  async saveDiscoveryState(value) {
    this.#assertCommitAllowed();
    await this.store.set(this.#key("discoveryState"), value);
  }

  async discoveryState() {
    return this.store.get(this.#key("discoveryState"));
  }

  async invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") {
      this.#assertCommitAllowed();
      await this.store.delete(this.#key("tokens"));
    }
    if (scope === "all" || scope === "client") {
      this.#assertCommitAllowed();
      await this.store.delete(this.#key("clientInformation"));
    }
    if (scope === "all" || scope === "verifier") {
      this.#assertCommitAllowed();
      await this.store.delete(this.#key("codeVerifier"));
    }
    if (scope === "all" || scope === "discovery") {
      this.#assertCommitAllowed();
      await this.store.delete(this.#key("discoveryState"));
    }
  }

  #key(name) {
    return `${this.keyPrefix}:${name}`;
  }

  #assertCommitAllowed() {
    if (this.commitGuard()) return;
    const error = new Error("Longbridge authorization changed before OAuth state could be saved.");
    error.code = "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION";
    throw error;
  }
}

function normalizedIssuer(value) {
  return new URL(value).href.replace(/\/$/, "");
}

function validIssuer(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function requireBoundCredentials(value) {
  if (value != null && !validIssuer(value.issuer)) {
    // Preserve the original entry. Only the existing explicit reauthorization
    // confirmation may clear it; no migration guesses an issuer for secrets.
    const error = new Error("长桥 OAuth 旧授权缺少有效的发行方绑定，请点击“重新授权”完成只读授权。原授权记录保留，未用于联网。");
    error.code = "LONGBRIDGE_OAUTH_ISSUER_REQUIRED";
    throw error;
  }
  return value;
}
