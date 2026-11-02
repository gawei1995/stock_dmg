import { createHash } from "node:crypto";
import {
  expectedLastCompletedTradingDate,
  isUsTradingDay,
} from "../engine/market-evidence.mjs";

export const PORTFOLIO_VALUATION_GATE_SCHEMA_VERSION = "portfolio-valuation-gate/v1";
export const PORTFOLIO_VALUATION_GATE_METHOD_VERSION = "portfolio-valuation-gate-v1";

export const DEFAULT_PORTFOLIO_VALUATION_POLICY = Object.freeze({
  accountSyncMaxAgeMs: 2 * 60 * 1000,
  futureTimestampToleranceMs: 90 * 1000,
  regularQuoteMaxAgeMs: 5 * 60 * 1000,
  extendedQuoteMaxAgeMs: 15 * 60 * 1000,
  regularCrossSymbolSkewMaxMs: 2 * 60 * 1000,
  extendedCrossSymbolSkewMaxMs: 5 * 60 * 1000,
  reconciliationAbsoluteTolerance: 5,
  reconciliationWarnBps: 100,
  reconciliationBlockBps: 500,
  positionValueRelativeToleranceBps: 10,
});

const MARKET_SCHEDULES = Object.freeze({
  US: {
    timeZone: "America/New_York",
    regularSegments: [[9 * 60 + 30, 16 * 60]],
    hasExtendedHours: true,
  },
  HK: {
    timeZone: "Asia/Hong_Kong",
    regularSegments: [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60]],
    hasExtendedHours: false,
  },
  CN: {
    timeZone: "Asia/Shanghai",
    regularSegments: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]],
    hasExtendedHours: false,
  },
  SH: {
    timeZone: "Asia/Shanghai",
    regularSegments: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]],
    hasExtendedHours: false,
  },
  SZ: {
    timeZone: "Asia/Shanghai",
    regularSegments: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]],
    hasExtendedHours: false,
  },
  SG: {
    timeZone: "Asia/Singapore",
    regularSegments: [[9 * 60, 17 * 60]],
    hasExtendedHours: false,
  },
});

const SEVERITY_RANK = Object.freeze({ degraded: 1, block: 2 });
const ACTIVE_QUOTE_PHASES = new Set(["regular", "pre_market", "post_market", "overnight"]);
const NORMAL_TRADE_STATUS = new Set(["", "normal", "normalstatus", "trading", "tradingstatus"]);

/**
 * Pure, deterministic portfolio valuation gate. `assessedAt` is required so
 * the same portfolio and wall-clock instant always produce the same result.
 * Account synchronization and per-instrument quote time are assessed
 * independently; a recent holdings response never upgrades an old mark.
 */
export function assessPortfolioValuationGate({
  portfolio,
  assessedAt,
  policy = {},
} = {}) {
  const at = requiredInstant(assessedAt, "assessedAt");
  const resolvedPolicy = normalizePolicy(policy);
  const source = portfolio && typeof portfolio === "object" && !Array.isArray(portfolio)
    ? portfolio
    : {};
  const rawPositions = Array.isArray(source.positions) ? source.positions : [];
  const normalizedInputs = rawPositions
    .map((position, index) => normalizePositionInput(position, index))
    .sort(comparePositionInputs);
  const input = canonicalInput(source, normalizedInputs);
  const inputHash = hashCanonical(input);
  const issues = [];

  const accountSync = assessAccountSync(source, at, resolvedPolicy, issues);
  const positions = normalizedInputs.map((position) => assessPosition({
    position,
    assessedAt: at,
    policy: resolvedPolicy,
    issues,
  }));
  const quoteCohorts = assessQuoteCohorts(positions, resolvedPolicy, issues);
  const reconciliation = assessValuationReconciliation({
    portfolio: source,
    positions,
    policy: resolvedPolicy,
    issues,
  });

  const sortedIssues = issues.sort(compareIssues);
  const status = sortedIssues.some((issue) => issue.severity === "block")
    ? "block"
    : sortedIssues.some((issue) => issue.severity === "degraded")
      ? "degraded"
      : "pass";
  const reasonCodes = [...new Set(sortedIssues.map((issue) => issue.code))];
  const result = {
    schemaVersion: PORTFOLIO_VALUATION_GATE_SCHEMA_VERSION,
    methodVersion: PORTFOLIO_VALUATION_GATE_METHOD_VERSION,
    assessedAt: at.toISOString(),
    inputHash,
    policy: resolvedPolicy,
    accountSync,
    positions,
    quoteCohorts,
    reconciliation,
    outcome: {
      status,
      quoteAndValuationCurrent: status === "pass",
      readyForDecision: status === "pass",
      readyForSizing: status === "pass",
      reasonCodes,
      blockingReasonCodes: [...new Set(sortedIssues
        .filter((issue) => issue.severity === "block")
        .map((issue) => issue.code))],
      degradedReasonCodes: [...new Set(sortedIssues
        .filter((issue) => issue.severity === "degraded")
        .map((issue) => issue.code))],
    },
    issues: sortedIssues,
    limitations: [
      "account_sync_time_is_not_quote_time",
      "quote_freshness_does_not_prove_market_liquidity_or_executability",
      "non_us_exchange_holidays_require_provider_calendar_confirmation",
      "net_asset_reconciliation_can_include_broker_accruals_or_unmodelled_assets",
    ],
  };
  return deepFreeze({ ...result, hash: hashCanonical(result) });
}

export function stablePortfolioValuationGateHash(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("portfolio valuation gate value must be an object");
  }
  const { hash: _hash, ...withoutHash } = value;
  return hashCanonical(withoutHash);
}

function assessAccountSync(portfolio, assessedAt, policy, issues) {
  const rawTimestamp = portfolio.syncedAt;
  const timestamp = optionalInstant(rawTimestamp);
  const sourceStatus = cleanLower(portfolio.status) || "unknown";
  const holdingsStatus = cleanLower(portfolio.holdingsStatus) || "unknown";
  const reasonCodes = [];
  let ageMs = null;
  if (!timestamp) {
    addIssue(issues, {
      code: "account_sync_time_missing",
      severity: "block",
      scope: "account_sync",
      field: "syncedAt",
    });
    reasonCodes.push("account_sync_time_missing");
  } else {
    const rawAge = assessedAt.getTime() - timestamp.getTime();
    ageMs = Math.max(0, rawAge);
    if (rawAge < -policy.futureTimestampToleranceMs) {
      addIssue(issues, {
        code: "account_sync_time_in_future",
        severity: "block",
        scope: "account_sync",
        field: "syncedAt",
        observed: timestamp.toISOString(),
      });
      reasonCodes.push("account_sync_time_in_future");
    } else if (rawAge > policy.accountSyncMaxAgeMs) {
      addIssue(issues, {
        code: "account_sync_expired",
        severity: "block",
        scope: "account_sync",
        field: "syncedAt",
        observed: ageMs,
        threshold: policy.accountSyncMaxAgeMs,
        unit: "millisecond",
      });
      reasonCodes.push("account_sync_expired");
    }
  }
  if (["cached", "stale"].includes(sourceStatus) || ["cached", "stale"].includes(holdingsStatus)) {
    addIssue(issues, {
      code: "account_snapshot_not_live",
      severity: "block",
      scope: "account_sync",
      field: "status",
      observed: `${sourceStatus}/${holdingsStatus}`,
    });
    reasonCodes.push("account_snapshot_not_live");
  } else if (!["live", "degraded"].includes(sourceStatus) || holdingsStatus !== "live") {
    addIssue(issues, {
      code: "account_snapshot_status_unknown",
      severity: "degraded",
      scope: "account_sync",
      field: "status",
      observed: `${sourceStatus}/${holdingsStatus}`,
    });
    reasonCodes.push("account_snapshot_status_unknown");
  }
  if (portfolio.account?.valuationComplete === false) {
    addIssue(issues, {
      code: "account_valuation_incomplete",
      severity: "block",
      scope: "account_sync",
      field: "account.valuationComplete",
      observed: false,
      expected: true,
    });
    reasonCodes.push("account_valuation_incomplete");
  }
  if (portfolio.dataQuality?.valuationComplete === false) {
    addIssue(issues, {
      code: "portfolio_valuation_completeness_failed",
      severity: "block",
      scope: "account_sync",
      field: "dataQuality.valuationComplete",
      observed: false,
      expected: true,
    });
    reasonCodes.push("portfolio_valuation_completeness_failed");
  }
  return {
    status: statusFromReasonCodes(reasonCodes, issues, "account_sync"),
    sourceStatus,
    holdingsStatus,
    syncedAt: timestamp?.toISOString() ?? null,
    ageMs,
    maxAgeMs: policy.accountSyncMaxAgeMs,
    reasonCodes,
  };
}

function assessPosition({ position, assessedAt, policy, issues }) {
  const localIssues = [];
  const addLocal = (issue) => {
    const normalized = addIssue(issues, {
      ...issue,
      scope: "position",
      symbol: position.symbol,
    });
    localIssues.push(normalized);
  };
  const instrument = resolveInstrumentType(position);
  const market = resolveMarket(position);
  const schedule = MARKET_SCHEDULES[market] ?? null;
  const quantity = finiteNumberOrNull(position.quantity);
  const grossQuantity = finiteNumberOrNull(position.grossQuantity);
  const price = finiteNumberOrNull(position.lastPrice);
  const quoteAt = optionalInstant(position.quoteTimestamp);
  const quoteSession = normalizeQuoteSession(position.quoteSession);
  const valuationStatus = cleanLower(position.valuationStatus) || inferValuationStatus(position);
  const marketValueBase = finiteNumberOrNull(position.marketValueBase);
  const marketValueNative = finiteNumberOrNull(position.marketValue);
  const grossMarketValueBase = finiteNumberOrNull(position.grossMarketValueBase);
  const multiplier = finiteNumberOrNull(position.contractMultiplier);
  const phase = schedule
    ? marketPhase({ market, instant: assessedAt, instrumentType: instrument.type })
    : unknownMarketPhase(market);

  if (quantity == null) {
    addLocal({ code: "position_quantity_missing", severity: "block", field: "quantity" });
  }
  if (instrument.type === "unknown") {
    addLocal({
      code: "instrument_type_unknown",
      severity: "block",
      field: "instrumentType",
      observed: position.instrumentType,
    });
  }
  if (!schedule) {
    addLocal({
      code: "market_schedule_unknown",
      severity: "block",
      field: "market",
      observed: market,
    });
  }

  const hasExposure = quantity != null && (quantity !== 0 || (grossQuantity != null && grossQuantity > 0));
  const noExposure = quantity === 0 && !(grossQuantity > 0);
  if (grossQuantity != null && grossQuantity < Math.abs(quantity ?? 0)) {
    addLocal({
      code: "position_gross_quantity_inconsistent",
      severity: "block",
      field: "grossQuantity",
      observed: grossQuantity,
      expected: Math.abs(quantity ?? 0),
    });
  }
  if (hasExposure) {
    if (price == null) {
      addLocal({ code: "quote_price_missing", severity: "block", field: "lastPrice" });
    } else if (price === 0) {
      addLocal({
        code: "quote_price_zero",
        severity: "block",
        field: "lastPrice",
        observed: 0,
      });
    } else if (price < 0) {
      addLocal({
        code: "quote_price_negative",
        severity: "block",
        field: "lastPrice",
        observed: price,
      });
    }
    if (!quoteAt) {
      addLocal({ code: "quote_timestamp_missing", severity: "block", field: "quoteTimestamp" });
    }
    if (instrument.type === "option") {
      if (multiplier == null) {
        addLocal({
          code: "option_contract_multiplier_missing",
          severity: "block",
          field: "contractMultiplier",
        });
      } else if (multiplier === 0) {
        addLocal({
          code: "option_contract_multiplier_zero",
          severity: "block",
          field: "contractMultiplier",
          observed: 0,
        });
      } else if (multiplier < 0) {
        addLocal({
          code: "option_contract_multiplier_negative",
          severity: "block",
          field: "contractMultiplier",
          observed: multiplier,
        });
      }
    }
    if (valuationStatus !== "priced") {
      addLocal({
        code: valuationStatus === "native_only"
          ? "position_base_currency_conversion_missing"
          : "position_valuation_unpriced",
        severity: "block",
        field: "valuationStatus",
        observed: valuationStatus,
      });
    }
    if (marketValueBase == null) {
      addLocal({
        code: "position_market_value_base_missing",
        severity: "block",
        field: "marketValueBase",
      });
    }
  }

  let quoteAgeMs = null;
  let quoteLocalDate = null;
  let quoteState = noExposure ? "not_applicable" : "unknown";
  if (hasExposure && quoteAt && schedule) {
    const rawAge = assessedAt.getTime() - quoteAt.getTime();
    quoteAgeMs = Math.max(0, rawAge);
    quoteLocalDate = zonedDateParts(quoteAt, schedule.timeZone).date;
    if (rawAge < -policy.futureTimestampToleranceMs) {
      addLocal({
        code: "quote_timestamp_in_future",
        severity: "block",
        field: "quoteTimestamp",
        observed: quoteAt.toISOString(),
      });
      quoteState = "future";
    } else if (phase.requiresActiveQuote) {
      const expectedSession = expectedQuoteSession(phase.phase);
      const maxAgeMs = phase.phase === "regular"
        ? policy.regularQuoteMaxAgeMs
        : policy.extendedQuoteMaxAgeMs;
      if (quoteSession !== expectedSession) {
        const latestCompleted = phase.expectedLatestCompletedTradeDate;
        if (phase.phase !== "regular"
            && quoteLocalDate
            && latestCompleted
            && quoteLocalDate >= latestCompleted) {
          addLocal({
            code: "extended_session_mark_not_current",
            severity: "degraded",
            field: "quoteSession",
            observed: quoteSession,
            expected: expectedSession,
          });
          quoteState = "accepted_prior_session_mark";
        } else {
          addLocal({
            code: "active_session_quote_session_mismatch",
            severity: "degraded",
            field: "quoteSession",
            observed: quoteSession,
            expected: expectedSession,
          });
          quoteState = "session_mismatch";
        }
        if (phase.phase === "regular" && rawAge > maxAgeMs) {
          addLocal({
            code: "quote_stale_active_session",
            severity: "block",
            field: "quoteTimestamp",
            observed: quoteAgeMs,
            threshold: maxAgeMs,
            unit: "millisecond",
          });
          quoteState = "stale_active";
        }
      } else if (rawAge > maxAgeMs) {
        addLocal({
          code: "quote_stale_active_session",
          severity: "block",
          field: "quoteTimestamp",
          observed: quoteAgeMs,
          threshold: maxAgeMs,
          unit: "millisecond",
        });
        quoteState = "stale_active";
      } else {
        quoteState = "fresh_active";
      }
    } else {
      const minimumTradeDate = phase.phase === "session_break"
        ? phase.localTradingDate
        : phase.expectedLatestCompletedTradeDate;
      if (!minimumTradeDate) {
        addLocal({
          code: "expected_completed_session_unknown",
          severity: "block",
          field: "quoteTimestamp",
        });
        quoteState = "completion_unknown";
      } else if (!quoteLocalDate || quoteLocalDate < minimumTradeDate) {
        addLocal({
          code: phase.phase === "session_break"
            ? "quote_missing_current_trading_session"
            : "quote_older_than_latest_completed_session",
          severity: "block",
          field: "quoteTimestamp",
          observed: quoteLocalDate,
          expected: minimumTradeDate,
        });
        quoteState = "older_than_required_session";
      } else {
        quoteState = phase.phase === "session_break"
          ? "accepted_exchange_break"
          : "accepted_market_closed";
      }
    }
  }

  if (hasExposure && !NORMAL_TRADE_STATUS.has(cleanLower(position.tradeStatus))) {
    addLocal({
      code: "instrument_not_trading_normally",
      severity: "degraded",
      field: "tradeStatus",
      observed: position.tradeStatus,
    });
  }

  if (hasExposure
      && quantity != null
      && price != null
      && price > 0
      && marketValueNative != null
      && instrument.type !== "unknown") {
    const appliedMultiplier = instrument.type === "option" ? multiplier : 1;
    if (appliedMultiplier != null && appliedMultiplier > 0) {
      const expectedNativeValue = quantity * price * appliedMultiplier;
      const difference = marketValueNative - expectedNativeValue;
      const relativeBps = Math.abs(difference) / Math.max(Math.abs(expectedNativeValue), 1) * 10_000;
      if (relativeBps > policy.positionValueRelativeToleranceBps) {
        addLocal({
          code: "position_native_market_value_mismatch",
          severity: "block",
          field: "marketValue",
          observed: marketValueNative,
          expected: expectedNativeValue,
          difference,
          relativeBps,
          threshold: policy.positionValueRelativeToleranceBps,
          unit: "basis_point",
        });
      }
    }
  }

  const reasonCodes = [...new Set(localIssues.map((issue) => issue.code))];
  const status = localIssues.some((issue) => issue.severity === "block")
    ? "block"
    : localIssues.some((issue) => issue.severity === "degraded")
      ? "degraded"
      : "pass";
  return {
    symbol: position.symbol,
    instrumentType: instrument.type,
    instrumentTypeSource: instrument.source,
    market,
    currency: position.currency,
    quantity,
    grossQuantity,
    hasExposure,
    quote: {
      price,
      timestamp: quoteAt?.toISOString() ?? null,
      ageMs: quoteAgeMs,
      localTradeDate: quoteLocalDate,
      session: quoteSession,
      state: quoteState,
    },
    marketClock: phase,
    valuation: {
      status: valuationStatus,
      marketValue: marketValueNative,
      marketValueBase,
      grossMarketValueBase,
      contractMultiplier: instrument.type === "option" ? multiplier : 1,
    },
    status,
    readyForSizing: status === "pass",
    reasonCodes,
  };
}

function assessQuoteCohorts(positions, policy, issues) {
  const groups = new Map();
  for (const position of positions) {
    if (!position.marketClock.requiresActiveQuote
        || !ACTIVE_QUOTE_PHASES.has(position.marketClock.phase)
        || !position.hasExposure
        || !position.quote.timestamp) continue;
    const key = `${position.market}:${position.marketClock.phase}`;
    const values = groups.get(key) ?? [];
    values.push(position);
    groups.set(key, values);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, rows]) => {
    const timestamps = rows.map((row) => Date.parse(row.quote.timestamp)).filter(Number.isFinite);
    const oldestMs = Math.min(...timestamps);
    const newestMs = Math.max(...timestamps);
    const skewMs = timestamps.length > 1 ? newestMs - oldestMs : 0;
    const phase = rows[0].marketClock.phase;
    const threshold = phase === "regular"
      ? policy.regularCrossSymbolSkewMaxMs
      : policy.extendedCrossSymbolSkewMaxMs;
    const exceeded = skewMs > threshold;
    if (exceeded) {
      addIssue(issues, {
        code: "cross_symbol_quote_skew_exceeded",
        severity: "degraded",
        scope: "quote_cohort",
        cohort: key,
        observed: skewMs,
        threshold,
        unit: "millisecond",
        symbols: rows.map((row) => row.symbol).sort(),
      });
    }
    return {
      cohort: key,
      market: rows[0].market,
      phase,
      symbolCount: rows.length,
      symbols: rows.map((row) => row.symbol).sort(),
      oldestQuoteAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
      newestQuoteAt: Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : null,
      skewMs,
      maxSkewMs: threshold,
      status: exceeded ? "degraded" : "pass",
      reasonCodes: exceeded ? ["cross_symbol_quote_skew_exceeded"] : [],
    };
  });
}

function assessValuationReconciliation({ portfolio, positions, policy, issues }) {
  const netAssets = finiteNumberOrNull(portfolio.account?.netAssets);
  const totalCash = finiteNumberOrNull(portfolio.account?.totalCash);
  const activePositions = positions.filter((position) => position.hasExposure);
  const missingBaseValues = activePositions.filter(
    (position) => position.valuation.marketValueBase == null,
  ).map((position) => position.symbol);
  const reasonCodes = [];

  if (netAssets == null) {
    addReconciliationIssue("account_net_assets_missing", "netAssets");
  } else if (netAssets === 0) {
    addReconciliationIssue("account_net_assets_zero", "netAssets", 0);
  } else if (netAssets < 0) {
    addReconciliationIssue("account_net_assets_negative", "netAssets", netAssets);
  }
  if (totalCash == null) addReconciliationIssue("account_total_cash_missing", "totalCash");
  if (missingBaseValues.length) {
    addIssue(issues, {
      code: "reconciliation_position_values_missing",
      severity: "block",
      scope: "reconciliation",
      field: "marketValueBase",
      symbols: missingBaseValues.sort(),
    });
    reasonCodes.push("reconciliation_position_values_missing");
  }

  const positionNetValue = missingBaseValues.length
    ? null
    : activePositions.reduce((sum, position) => sum + position.valuation.marketValueBase, 0);
  const declaredPositionNetValue = finiteNumberOrNull(portfolio.totals?.positionsNetMarketValueBase);
  if (positionNetValue != null && declaredPositionNetValue != null) {
    const declaredDifference = declaredPositionNetValue - positionNetValue;
    if (Math.abs(declaredDifference) > policy.reconciliationAbsoluteTolerance) {
      addIssue(issues, {
        code: "portfolio_position_total_mismatch",
        severity: "block",
        scope: "reconciliation",
        field: "positionsNetMarketValueBase",
        observed: declaredPositionNetValue,
        expected: positionNetValue,
        difference: declaredDifference,
        threshold: policy.reconciliationAbsoluteTolerance,
        unit: currencyUnit(portfolio),
      });
      reasonCodes.push("portfolio_position_total_mismatch");
    }
  }

  const reconstructedNetAssets = totalCash != null && positionNetValue != null
    ? totalCash + positionNetValue
    : null;
  const residual = netAssets != null && reconstructedNetAssets != null
    ? netAssets - reconstructedNetAssets
    : null;
  const residualBps = residual != null && netAssets !== 0
    ? Math.abs(residual) / Math.abs(netAssets) * 10_000
    : null;
  if (residual != null && netAssets !== 0) {
    const outsideAbsolute = Math.abs(residual) > policy.reconciliationAbsoluteTolerance;
    if (outsideAbsolute && residualBps > policy.reconciliationBlockBps) {
      addIssue(issues, {
        code: "net_asset_reconciliation_failed",
        severity: "block",
        scope: "reconciliation",
        field: "netAssets",
        observed: netAssets,
        expected: reconstructedNetAssets,
        difference: residual,
        relativeBps: residualBps,
        threshold: policy.reconciliationBlockBps,
        unit: "basis_point",
      });
      reasonCodes.push("net_asset_reconciliation_failed");
    } else if (outsideAbsolute && residualBps > policy.reconciliationWarnBps) {
      addIssue(issues, {
        code: "net_asset_reconciliation_degraded",
        severity: "degraded",
        scope: "reconciliation",
        field: "netAssets",
        observed: netAssets,
        expected: reconstructedNetAssets,
        difference: residual,
        relativeBps: residualBps,
        threshold: policy.reconciliationWarnBps,
        unit: "basis_point",
      });
      reasonCodes.push("net_asset_reconciliation_degraded");
    }
  }

  const status = reasonCodes.some((code) => issues.some(
    (issue) => issue.scope === "reconciliation" && issue.code === code && issue.severity === "block",
  ))
    ? "block"
    : reasonCodes.length
      ? "degraded"
      : "pass";
  return {
    status,
    baseCurrency: String(portfolio.account?.baseCurrency ?? "").toUpperCase() || null,
    accountNetAssets: netAssets,
    totalCash,
    positionNetMarketValueBase: positionNetValue,
    reconstructedNetAssets,
    residual,
    residualBps,
    absoluteTolerance: policy.reconciliationAbsoluteTolerance,
    warnBps: policy.reconciliationWarnBps,
    blockBps: policy.reconciliationBlockBps,
    reasonCodes,
  };

  function addReconciliationIssue(code, field, observed = undefined) {
    addIssue(issues, {
      code,
      severity: "block",
      scope: "reconciliation",
      field,
      ...(observed === undefined ? {} : { observed }),
    });
    reasonCodes.push(code);
  }
}

function marketPhase({ market, instant, instrumentType }) {
  const schedule = MARKET_SCHEDULES[market];
  const local = zonedDateParts(instant, schedule.timeZone);
  const tradingDay = isTradingDay(market, local.date);
  const expectedLatestCompletedTradeDate = expectedLastCompletedTradingDate({
    market,
    analysisTime: instant.toISOString(),
  });
  let phase = "closed";
  let requiresActiveQuote = false;
  if (tradingDay) {
    const segments = effectiveRegularSegments(market, local, expectedLatestCompletedTradeDate);
    if (segments.some(([open, close]) => local.minuteOfDay >= open && local.minuteOfDay < close)) {
      phase = "regular";
      requiresActiveQuote = true;
    } else if (betweenRegularSegments(local.minuteOfDay, segments)) {
      phase = "session_break";
    } else if (market === "US" && instrumentType !== "option") {
      const closeMinute = segments.at(-1)[1];
      if (local.minuteOfDay >= 4 * 60 && local.minuteOfDay < segments[0][0]) {
        phase = "pre_market";
        requiresActiveQuote = true;
      } else if (local.minuteOfDay >= closeMinute && local.minuteOfDay < 20 * 60) {
        phase = "post_market";
        requiresActiveQuote = true;
      } else if (isUsOvernightSession(local)) {
        phase = "overnight";
        requiresActiveQuote = true;
      }
    }
  } else if (market === "US" && instrumentType !== "option" && isUsOvernightSession(local)) {
    phase = "overnight";
    requiresActiveQuote = true;
  }
  return {
    phase,
    timeZone: schedule.timeZone,
    localTradingDate: local.date,
    localMinuteOfDay: local.minuteOfDay,
    isTradingDay: tradingDay,
    requiresActiveQuote,
    expectedLatestCompletedTradeDate,
    calendarConfidence: market === "US" ? "exchange_holiday_aware" : "weekday_only",
  };
}

function effectiveRegularSegments(market, local, expectedLatestCompletedTradeDate) {
  const base = MARKET_SCHEDULES[market].regularSegments;
  if (market !== "US") return base;
  const earlyCloseFinalized = expectedLatestCompletedTradeDate === local.date
    && local.minuteOfDay >= 13 * 60
    && local.minuteOfDay < 16 * 60;
  return earlyCloseFinalized ? [[9 * 60 + 30, 13 * 60]] : base;
}

function isUsOvernightSession(local) {
  const weekday = utcWeekday(local.date);
  if (local.minuteOfDay < 4 * 60) {
    return weekday >= 1 && weekday <= 5 && isUsTradingDay(local.date);
  }
  if (local.minuteOfDay < 20 * 60) return false;
  const next = addDays(local.date, 1);
  return isUsTradingDay(next) && [0, 1, 2, 3, 4].includes(weekday);
}

function unknownMarketPhase(market) {
  return {
    phase: "unknown",
    timeZone: null,
    localTradingDate: null,
    localMinuteOfDay: null,
    isTradingDay: null,
    requiresActiveQuote: false,
    expectedLatestCompletedTradeDate: null,
    calendarConfidence: "unknown",
    market,
  };
}

function expectedQuoteSession(phase) {
  if (phase === "regular") return "regular";
  return phase;
}

function isTradingDay(market, date) {
  return market === "US" ? isUsTradingDay(date) : isWeekday(date);
}

function betweenRegularSegments(minute, segments) {
  if (segments.length < 2) return false;
  return segments.slice(0, -1).some((segment, index) => (
    minute >= segment[1] && minute < segments[index + 1][0]
  ));
}

function resolveInstrumentType(position) {
  const explicit = cleanLower(position.instrumentType);
  if (explicit === "equity" || explicit === "option") {
    return { type: explicit, source: "explicit" };
  }
  const localCode = position.symbol.split(".")[0];
  if (/\d{6}[CP]\d+$/i.test(localCode)) return { type: "option", source: "symbol_pattern" };
  if (/^[A-Z0-9][A-Z0-9._-]{0,39}$/i.test(position.symbol) && position.symbol.includes(".")) {
    return { type: "equity", source: "symbol_pattern" };
  }
  return { type: "unknown", source: "unresolved" };
}

function resolveMarket(position) {
  const explicit = String(position.market ?? "").trim().toUpperCase();
  if (MARKET_SCHEDULES[explicit]) return explicit;
  const suffix = position.symbol.split(".").at(-1).toUpperCase();
  return MARKET_SCHEDULES[suffix] ? suffix : explicit || suffix || "UNKNOWN";
}

function normalizePositionInput(position, index) {
  const value = position && typeof position === "object" && !Array.isArray(position)
    ? position
    : {};
  return {
    symbol: String(value.symbol ?? "").trim().toUpperCase() || `UNKNOWN#${index}`,
    instrumentType: value.instrumentType == null ? null : String(value.instrumentType),
    market: value.market == null ? null : String(value.market),
    currency: String(value.currency ?? "").trim().toUpperCase() || null,
    quantity: preserveNumeric(value.quantity),
    grossQuantity: preserveNumeric(value.grossQuantity),
    lastPrice: preserveNumeric(value.lastPrice),
    quoteTimestamp: value.quoteTimestamp == null ? null : String(value.quoteTimestamp),
    quoteSession: value.quoteSession == null ? null : String(value.quoteSession),
    tradeStatus: value.tradeStatus == null ? null : String(value.tradeStatus),
    valuationStatus: value.valuationStatus == null ? null : String(value.valuationStatus),
    marketValue: preserveNumeric(value.marketValue),
    marketValueBase: preserveNumeric(value.marketValueBase),
    grossMarketValueBase: preserveNumeric(value.grossMarketValueBase),
    contractMultiplier: preserveNumeric(value.contractMultiplier),
  };
}

function canonicalInput(portfolio, positions) {
  return {
    portfolio: {
      status: portfolio.status == null ? null : String(portfolio.status),
      holdingsStatus: portfolio.holdingsStatus == null ? null : String(portfolio.holdingsStatus),
      valuationStatus: portfolio.valuationStatus == null ? null : String(portfolio.valuationStatus),
      syncedAt: portfolio.syncedAt == null ? null : String(portfolio.syncedAt),
      account: {
        baseCurrency: portfolio.account?.baseCurrency == null
          ? null
          : String(portfolio.account.baseCurrency).toUpperCase(),
        netAssets: preserveNumeric(portfolio.account?.netAssets),
        totalCash: preserveNumeric(portfolio.account?.totalCash),
        valuationComplete: optionalBoolean(portfolio.account?.valuationComplete),
      },
      dataQuality: {
        valuationComplete: optionalBoolean(portfolio.dataQuality?.valuationComplete),
      },
      totals: {
        positionsNetMarketValueBase: preserveNumeric(
          portfolio.totals?.positionsNetMarketValueBase,
        ),
      },
      positions,
    },
  };
}

function normalizePolicy(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const policy = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PORTFOLIO_VALUATION_POLICY)) {
    const value = source[key] == null ? fallback : Number(source[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`portfolio valuation policy ${key} must be a non-negative finite number`);
    }
    policy[key] = value;
  }
  if (policy.reconciliationWarnBps > policy.reconciliationBlockBps) {
    throw new TypeError("reconciliationWarnBps cannot exceed reconciliationBlockBps");
  }
  return policy;
}

function addIssue(target, input) {
  const issue = {
    code: String(input.code),
    severity: input.severity === "block" ? "block" : "degraded",
    scope: String(input.scope),
    symbol: input.symbol == null ? null : String(input.symbol),
    cohort: input.cohort == null ? null : String(input.cohort),
    field: input.field == null ? null : String(input.field),
    observed: normalizeIssueValue(input.observed),
    expected: normalizeIssueValue(input.expected),
    difference: normalizeIssueValue(input.difference),
    relativeBps: normalizeIssueValue(input.relativeBps),
    threshold: normalizeIssueValue(input.threshold),
    unit: input.unit == null ? null : String(input.unit),
    symbols: Array.isArray(input.symbols) ? [...input.symbols].map(String).sort() : [],
  };
  target.push(issue);
  return issue;
}

function normalizeIssueValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? canonicalNumber(value) : null;
  if (typeof value === "boolean") return value;
  return String(value);
}

function statusFromReasonCodes(reasonCodes, issues, scope) {
  if (reasonCodes.some((code) => issues.some(
    (issue) => issue.scope === scope && issue.code === code && issue.severity === "block",
  ))) return "block";
  return reasonCodes.length ? "degraded" : "pass";
}

function comparePositionInputs(left, right) {
  return left.symbol.localeCompare(right.symbol)
    || canonicalStringify(left).localeCompare(canonicalStringify(right));
}

function compareIssues(left, right) {
  return (SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity])
    || left.scope.localeCompare(right.scope)
    || String(left.symbol ?? "").localeCompare(String(right.symbol ?? ""))
    || left.code.localeCompare(right.code)
    || String(left.cohort ?? "").localeCompare(String(right.cohort ?? ""));
}

function inferValuationStatus(position) {
  return finiteNumberOrNull(position.marketValueBase) == null ? "unpriced" : "priced";
}

function normalizeQuoteSession(value) {
  const session = cleanLower(value);
  if (["regular", "pre_market", "post_market", "overnight"].includes(session)) return session;
  return "unknown";
}

function preserveNumeric(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? canonicalNumber(value) : null;
  if (typeof value === "bigint") return value.toString();
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? canonicalNumber(parsed) : null;
}

function finiteNumberOrNull(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? canonicalNumber(parsed) : null;
}

function canonicalNumber(value) {
  return Object.is(value, -0) ? 0 : value;
}

function requiredInstant(value, field) {
  const parsed = optionalInstant(value);
  if (!parsed) throw new TypeError(`${field} must be a valid ISO timestamp or Date`);
  return parsed;
}

function optionalInstant(value) {
  if (value == null || value === "") return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function isWeekday(date) {
  const weekday = utcWeekday(date);
  return weekday >= 1 && weekday <= 5;
}

function utcWeekday(date) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function cleanLower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function optionalBoolean(value) {
  return value === true ? true : value === false ? false : null;
}

function currencyUnit(portfolio) {
  const currency = String(portfolio.account?.baseCurrency ?? "").trim().toUpperCase();
  return currency || "base_currency";
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`;
}

function canonicalStringify(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical hash cannot include non-finite numbers");
    return JSON.stringify(canonicalNumber(value));
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const pairs = Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
    ));
    return `{${pairs.join(",")}}`;
  }
  throw new TypeError(`unsupported canonical hash value: ${typeof value}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
