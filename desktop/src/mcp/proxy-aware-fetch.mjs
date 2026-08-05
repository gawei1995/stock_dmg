/**
 * Adapt Electron's Chromium-backed net.fetch to the wider WHATWG fetch input
 * accepted by the MCP SDK. The SDK passes URL objects for Streamable HTTP.
 */
export function createProxyAwareFetch(electronFetch) {
  if (typeof electronFetch !== "function") {
    throw new TypeError("electronFetch must be a function.");
  }
  return (input, init) => electronFetch(
    input instanceof URL ? input.toString() : input,
    init,
  );
}
