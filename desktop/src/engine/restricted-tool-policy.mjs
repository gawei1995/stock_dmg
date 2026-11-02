// This is an explicitly selected, cold-thread capability boundary. It does
// not change user configuration, replace the ordinary broker guard, or claim
// to sandbox the native shell, files, web, or host-owned read-only evidence.
export const requiredRestrictedFeatures = Object.freeze(["apps", "plugins", "remote_plugin"]);

const SUPPORTED_FEATURE_STAGES = new Set(["stable", "experimental", "under development"]);
const MAX_FEATURE_OUTPUT_BYTES = 1_000_000;

export function supportsRestrictedToolFeatures(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_FEATURE_OUTPUT_BYTES) return false;
  const lines = stdout.split(/\r?\n/).map(line => line.trim());
  return requiredRestrictedFeatures.every(name => {
    const matches = lines.filter(line => line.startsWith(`${name} `) || line.startsWith(`${name}\t`) || line === name);
    if (matches.length !== 1) return false;
    const parsed = matches[0].match(/^([a-z_]+)\s+(stable|experimental|under\s+development|deprecated|removed)\s+(true|false)$/);
    return Boolean(parsed && parsed[1] === name && SUPPORTED_FEATURE_STAGES.has(parsed[2].replace(/\s+/g, " ")));
  });
}

export function buildRestrictedToolPolicy(effectiveConfig) {
  requireRecord(effectiveConfig, "effectiveConfig");
  const configuredApps = optionalMap(effectiveConfig.apps, "apps");
  const configuredServers = optionalMap(effectiveConfig.mcp_servers, "mcp_servers");
  const configuredPlugins = optionalMap(effectiveConfig.plugins, "plugins");

  const apps = Object.fromEntries(Object.entries(configuredApps).map(([id, value]) => {
    requireRecord(value, `apps.${id}`);
    return [id, { enabled: false, destructive_enabled: false }];
  }));
  apps._default = { enabled: false, destructive_enabled: false };

  const mcp_servers = disabledServerMap(configuredServers, "mcp_servers");
  const plugins = Object.fromEntries(Object.entries(configuredPlugins).map(([id, value]) => {
    requireRecord(value, `plugins.${id}`);
    const override = { enabled: false };
    if (value.mcp_servers != null) {
      override.mcp_servers = disabledServerMap(optionalMap(value.mcp_servers, `plugins.${id}.mcp_servers`), `plugins.${id}.mcp_servers`);
    }
    return [id, override];
  }));

  // Replay only deny deltas. config/read contains nullable/default fields
  // which are not necessarily valid thread/start override values.
  return {
    apps,
    mcp_servers,
    plugins,
    features: Object.fromEntries(requiredRestrictedFeatures.map(name => [name, false])),
  };
}

export function verifyRestrictedToolIsolation({ servers, apps, complete = true } = {}) {
  const unavailableTools = [];
  const result = (ready, reason) => ({ ready, reason, unavailableTools: [...new Set(unavailableTools)] });
  if (complete !== true || !Array.isArray(servers) || !Array.isArray(apps)) return result(false, "inventory_unavailable");

  let toolsVisible = false;
  let serverNotDisabled = false;
  let inventoryUnavailable = false;
  for (const server of servers) {
    if (!isRecord(server)) {
      unavailableTools.push("unknown");
      inventoryUnavailable = true;
      continue;
    }
    const name = typeof server.name === "string" && server.name.trim() ? server.name : "unknown";
    const validTools = Array.isArray(server.tools) || isRecord(server.tools);
    if (!validTools || server.toolsError || server.toolsUnavailable === true) {
      unavailableTools.push(name);
      inventoryUnavailable = true;
    }
    if (validTools && (Array.isArray(server.tools) ? server.tools.length : Object.keys(server.tools).length) > 0) toolsVisible = true;
    if (server.runtimeStatus !== "disabled") {
      unavailableTools.push(name);
      serverNotDisabled = true;
    }
  }
  if (inventoryUnavailable) return result(false, "inventory_unavailable");
  if (toolsVisible) return result(false, "external_tools_visible");

  for (const app of apps) {
    // Missing enabled/callable state is not proof of a disabled App.
    if (!isRecord(app) || app.enabled !== false || app.callable !== false) return result(false, "apps_callable");
  }
  if (serverNotDisabled) return result(false, "server_not_disabled");
  return result(true, "verified");
}

function disabledServerMap(value, label) {
  return Object.fromEntries(Object.entries(value).map(([id, config]) => {
    requireRecord(config, `${label}.${id}`);
    return [id, { enabled: false }];
  }));
}

function optionalMap(value, label) {
  if (value == null) return {};
  return requireRecord(value, label);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a configuration object`);
  return value;
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
