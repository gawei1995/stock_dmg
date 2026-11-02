import { createHash } from "node:crypto";

import { normalizeTechnicalSymbol } from "./technical-watchlist-store.mjs";

export const TECHNICAL_LINKAGE_STORE_KEY = "technicalLinkageProfilesV1";
export const TECHNICAL_LINKAGE_SCHEMA_VERSION = "technical-linkage-profiles/v1";
export const TECHNICAL_LINKAGE_MAX_PROFILES = 250;
export const TECHNICAL_LINKAGE_MAX_PEERS = 5;

/**
 * User-confirmed market-linkage profiles for deterministic Tier-B analysis.
 *
 * A model may suggest a sector or peer set, but only a profile whose state is
 * `confirmed` is allowed to trigger host market-data requests.  This keeps an
 * LLM classification proposal separate from observable price evidence.
 */
export class TechnicalLinkageStore {
  constructor({
    store,
    key = TECHNICAL_LINKAGE_STORE_KEY,
    maxProfiles = TECHNICAL_LINKAGE_MAX_PROFILES,
  } = {}) {
    if (!store?.get || !store?.set) {
      throw new TypeError("TechnicalLinkageStore requires an encrypted key-value store.");
    }
    this.store = store;
    this.key = String(key || TECHNICAL_LINKAGE_STORE_KEY);
    this.maxProfiles = positiveInteger(maxProfiles, TECHNICAL_LINKAGE_MAX_PROFILES);
    this.writeQueue = Promise.resolve();
  }

  async snapshot() {
    return structuredClone(normalizeState(await this.store.get(this.key), this.maxProfiles));
  }

  async get(symbol) {
    const normalized = normalizeTechnicalSymbol(symbol);
    const state = await this.snapshot();
    return structuredClone(state.profiles.find((profile) => profile.symbol === normalized) ?? null);
  }

  async propose({
    symbol,
    sectorSymbol = null,
    peerSymbols = [],
    rationale = null,
    source = "codex_proposal",
    proposedAt = new Date().toISOString(),
  } = {}) {
    const profile = normalizeProfile({
      symbol,
      sectorSymbol,
      peerSymbols,
      rationale,
      source,
      state: "proposed",
      proposedAt,
      confirmedAt: null,
      updatedAt: proposedAt,
    });
    return this.#upsert(profile, { allowConfirmedReplacement: false });
  }

  async confirm({
    symbol,
    sectorSymbol = null,
    peerSymbols = [],
    rationale = null,
    source = "user_confirmed",
    confirmedAt = new Date().toISOString(),
  } = {}) {
    const profile = normalizeProfile({
      symbol,
      sectorSymbol,
      peerSymbols,
      rationale,
      source,
      state: "confirmed",
      proposedAt: null,
      confirmedAt,
      updatedAt: confirmedAt,
    });
    return this.#upsert(profile, { allowConfirmedReplacement: true });
  }

  async remove(symbol, { removedAt = new Date().toISOString() } = {}) {
    const normalized = normalizeTechnicalSymbol(symbol);
    const at = normalizeIso(removedAt, "技术联动删除时间无效。");
    return this.#mutate((state) => {
      const profiles = state.profiles.filter((profile) => profile.symbol !== normalized);
      if (profiles.length === state.profiles.length) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        profiles,
      };
    });
  }

  async #upsert(profile, { allowConfirmedReplacement }) {
    return this.#mutate((state) => {
      const index = state.profiles.findIndex((item) => item.symbol === profile.symbol);
      const previous = index >= 0 ? state.profiles[index] : null;
      if (!previous && state.profiles.length >= this.maxProfiles) {
        throw linkageError(
          "technical_linkage_limit_reached",
          `技术联动配置最多保留 ${this.maxProfiles} 个标的。`,
        );
      }
      if (previous?.state === "confirmed" && profile.state === "proposed" && !allowConfirmedReplacement) {
        return state;
      }
      const nextProfile = {
        ...profile,
        proposedAt: profile.proposedAt ?? previous?.proposedAt ?? null,
      };
      const profiles = [...state.profiles];
      if (index >= 0) profiles[index] = nextProfile;
      else profiles.push(nextProfile);
      profiles.sort((left, right) => left.symbol.localeCompare(right.symbol));
      if (JSON.stringify(profiles) === JSON.stringify(state.profiles)) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: nextProfile.updatedAt,
        profiles,
      };
    });
  }

  async #mutate(updater) {
    const operation = this.writeQueue.then(async () => {
      const current = normalizeState(await this.store.get(this.key), this.maxProfiles);
      const next = normalizeState(updater(structuredClone(current)), this.maxProfiles);
      if (JSON.stringify(next) !== JSON.stringify(current)) await this.store.set(this.key, next);
      return structuredClone(next);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function confirmedTechnicalLinkage(value) {
  const profile = normalizeProfile(value);
  return profile.state === "confirmed" ? structuredClone(profile) : null;
}

function normalizeState(value, maxProfiles) {
  if (value == null) {
    return {
      schemaVersion: TECHNICAL_LINKAGE_SCHEMA_VERSION,
      revision: 0,
      updatedAt: null,
      profiles: [],
    };
  }
  if (!value || value.schemaVersion !== TECHNICAL_LINKAGE_SCHEMA_VERSION) {
    throw linkageError(
      "technical_linkage_state_invalid",
      "技术联动配置版本无效；未自动猜测或覆盖旧数据。",
    );
  }
  if (!Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.profiles)) {
    throw linkageError("technical_linkage_state_invalid", "技术联动配置结构无效。");
  }
  if (value.profiles.length > maxProfiles) {
    throw linkageError("technical_linkage_state_overflow", "技术联动配置超过容量，未静默裁剪。");
  }
  const seen = new Set();
  const profiles = value.profiles.map((profile) => {
    const normalized = normalizeProfile(profile);
    if (seen.has(normalized.symbol)) {
      throw linkageError(
        "technical_linkage_duplicate_symbol",
        `技术联动配置存在重复标的 ${normalized.symbol}。`,
      );
    }
    seen.add(normalized.symbol);
    return normalized;
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));
  return {
    schemaVersion: TECHNICAL_LINKAGE_SCHEMA_VERSION,
    revision: value.revision,
    updatedAt: value.updatedAt == null
      ? null
      : normalizeIso(value.updatedAt, "技术联动更新时间无效。"),
    profiles,
  };
}

function normalizeProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw linkageError("technical_linkage_profile_invalid", "技术联动配置必须是对象。");
  }
  const symbol = normalizeTechnicalSymbol(value.symbol);
  const sectorSymbol = optionalSymbol(value.sectorSymbol);
  const peerSymbols = [...new Set((Array.isArray(value.peerSymbols) ? value.peerSymbols : [])
    .map(normalizeTechnicalSymbol))]
    .filter((peer) => ![symbol, sectorSymbol].includes(peer))
    .sort();
  if (peerSymbols.length > TECHNICAL_LINKAGE_MAX_PEERS) {
    throw linkageError(
      "technical_linkage_peer_limit_reached",
      `每个标的最多配置 ${TECHNICAL_LINKAGE_MAX_PEERS} 个同行。`,
    );
  }
  if (!sectorSymbol && !peerSymbols.length) {
    throw linkageError(
      "technical_linkage_empty",
      "至少填写一个行业ETF或同行标的。",
    );
  }
  const state = String(value.state ?? "confirmed").trim().toLowerCase();
  if (!new Set(["proposed", "confirmed"]).has(state)) {
    throw linkageError("technical_linkage_state_invalid", "技术联动状态无效。");
  }
  if (state === "confirmed" && peerSymbols.length === 1) {
    throw linkageError(
      "technical_linkage_peer_group_too_small",
      "同行比较如启用，必须由用户确认 2–5 个同行；单一同行不能代表横向比较组。",
    );
  }
  const source = normalizeSource(value.source, state);
  const proposedAt = value.proposedAt == null
    ? null
    : normalizeIso(value.proposedAt, "技术联动建议时间无效。");
  const confirmedAt = value.confirmedAt == null
    ? null
    : normalizeIso(value.confirmedAt, "技术联动确认时间无效。");
  if (state === "confirmed" && !confirmedAt) {
    throw linkageError("technical_linkage_confirmation_missing", "已确认配置必须保留确认时间。");
  }
  if (state === "proposed" && !proposedAt) {
    throw linkageError("technical_linkage_proposal_time_missing", "待确认建议必须保留建议时间。");
  }
  const updatedAt = normalizeIso(
    value.updatedAt ?? confirmedAt ?? proposedAt,
    "技术联动更新时间无效。",
  );
  const normalized = {
    symbol,
    state,
    sectorSymbol,
    peerSymbols,
    rationale: normalizeText(value.rationale, 1_000),
    source,
    proposedAt,
    confirmedAt,
    updatedAt,
  };
  return {
    ...normalized,
    inputHash: hashCanonical(normalized),
  };
}

function optionalSymbol(value) {
  const text = String(value ?? "").trim();
  return text ? normalizeTechnicalSymbol(text) : null;
}

function normalizeSource(value, state) {
  const raw = String(value ?? (state === "confirmed" ? "user_confirmed" : "codex_proposal"))
    .trim()
    .toLowerCase();
  const allowed = state === "confirmed"
    ? new Set(["user_confirmed", "imported_user_confirmed"])
    : new Set(["codex_proposal", "imported_proposal"]);
  if (!allowed.has(raw)) {
    throw linkageError(
      "technical_linkage_source_invalid",
      state === "confirmed"
        ? "确定性联动只接受用户确认来源。"
        : "联动建议来源无效。",
    );
  }
  return raw;
}

function normalizeText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeIso(value, message) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw linkageError("technical_linkage_timestamp_invalid", message);
  return new Date(parsed).toISOString();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function linkageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
