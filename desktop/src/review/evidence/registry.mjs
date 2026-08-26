import { createHash } from "node:crypto";

/**
 * Indicator-agnostic evidence collection for reviews. EMA/Fib can be one
 * provider, but neither is required for a valid review case.
 */
export class EvidenceRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    const id = String(provider?.id ?? "").trim();
    if (!id || typeof provider?.collect !== "function") {
      throw new TypeError("Evidence provider requires an id and collect(context).");
    }
    this.providers.set(id, provider);
    return this;
  }

  async collect(context, { providerIds = null } = {}) {
    const selected = providerIds == null
      ? [...this.providers.values()]
      : providerIds.map((id) => this.providers.get(id)).filter(Boolean);
    const settled = await Promise.all(selected.map(async (provider) => {
      if (typeof provider.supports === "function" && !provider.supports(context)) return null;
      try {
        const result = await provider.collect(context);
        return createEvidenceEnvelope({
          ...result,
          providerId: provider.id,
          providerVersion: provider.version ?? "1",
        });
      } catch (error) {
        return createEvidenceEnvelope({
          type: provider.type ?? "unknown",
          providerId: provider.id,
          providerVersion: provider.version ?? "1",
          observedAt: new Date().toISOString(),
          asOf: null,
          status: "failed",
          quality: "unavailable",
          source: provider.source ?? provider.id,
          parameters: {},
          features: {},
          limitation: safeMessage(error),
        });
      }
    }));
    return settled.filter(Boolean);
  }
}

export function createEvidenceEnvelope(value) {
  const envelope = {
    evidenceId: cleanText(value?.evidenceId, 160) || cryptoId(value),
    type: cleanText(value?.type, 80) || "manual",
    providerId: cleanText(value?.providerId, 120) || "manual",
    providerVersion: cleanText(value?.providerVersion, 40) || "1",
    observedAt: normalizeIso(value?.observedAt) || new Date().toISOString(),
    asOf: normalizeIso(value?.asOf),
    status: enumValue(value?.status, ["ready", "stale", "degraded", "failed"], "ready"),
    quality: enumValue(value?.quality, ["verified", "reported", "inferred", "unavailable"], "reported"),
    source: cleanText(value?.source, 300),
    parameters: sanitizeObject(value?.parameters),
    features: sanitizeObject(value?.features),
    limitation: cleanText(value?.limitation, 1_000),
  };
  envelope.contentHash = createHash("sha256")
    .update(stableStringify({ ...envelope, contentHash: undefined }))
    .digest("hex");
  return envelope;
}

function cryptoId(value) {
  return createHash("sha256")
    .update(stableStringify(value ?? {}))
    .digest("hex")
    .slice(0, 24);
}

function sanitizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeIso(value) {
  if (value == null || value === "") return null;
  const millis = Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function enumValue(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error ?? "未知错误")).slice(0, 1_000);
}
