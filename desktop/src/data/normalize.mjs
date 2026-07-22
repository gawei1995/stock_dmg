import { getSymbolMetadata } from "../config/symbol-map.mjs";

const number = (value, fallback = 0) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function normalizePortfolio({
  positions,
  balances,
  quotes,
  exchangeRates,
  baseCurrency: requestedBaseCurrency = null,
  quoteErrors = [],
  sourceErrors = [],
  sourceWarnings = [],
  fxStatus = "live",
  fxMetadata = {},
}) {
  const rawPositions = aggregatePositions(flattenPositions(positions));
  const rawBalances = Array.isArray(balances)
    ? balances
    : balances?.balances ?? balances?.list ?? [];
  if (!rawBalances.length) {
    throw new Error("Longbridge account_balance returned no account records.");
  }

  const baseCurrency = String(
    requestedBaseCurrency || rawBalances[0]?.currency || "USD",
  ).toUpperCase();
  const quoteList = normalizeQuoteList(quotes);
  const quoteMap = new Map(quoteList.map((quote) => [quote.symbol, quote]));
  const fxGraph = buildFxGraph(exchangeRates);
  const account = aggregateBalances(rawBalances, baseCurrency, fxGraph);
  const netAssetsBase = account.netAssets > 0 ? account.netAssets : null;

  const normalized = rawPositions.map((position) => {
    const quote = quoteMap.get(position.symbol) ?? null;
    const instrumentType = inferInstrumentType(position.symbol);
    const mark = selectQuoteMark(quote);
    const quantity = number(position.quantity);
    const grossQuantity = number(position.gross_quantity, Math.abs(quantity));
    const costPrice = number(position.cost_price, NaN);
    const currency = String(position.currency || baseCurrency).toUpperCase();
    const contractMultiplier = instrumentType === "option"
      ? number(
        quote?.option_extend?.contract_multiplier
          ?? quote?.contract_multiplier
          ?? position.contract_multiplier,
        NaN,
      )
      : 1;
    const fxToBase = findConversionRate(currency, baseCurrency, fxGraph);
    const nativeLimitation = nativeValuationLimitation({
      symbol: position.symbol,
      instrumentType,
      mark,
      contractMultiplier,
    });
    const nativePricingAvailable = !nativeLimitation;
    const fxLimitation = fxToBase > 0
      ? null
      : `${position.symbol} 缺少到组合基准币种的可用汇率。`;
    const baseValuationAvailable = nativePricingAvailable && !fxLimitation;
    const limitation = nativeLimitation || fxLimitation;
    const lastPrice = nativePricingAvailable ? mark.price : null;
    const prevClose = number(quote?.prev_close, NaN);
    const nativeNetValue = nativePricingAvailable
      ? quantity * lastPrice * contractMultiplier
      : null;
    const nativeGrossValue = nativePricingAvailable
      ? grossQuantity * lastPrice * contractMultiplier
      : null;
    const nativeCostValue = nativePricingAvailable
      ? number(position.cost_value, quantity * number(costPrice)) * contractMultiplier
      : null;
    const nativeGrossCostValue = nativePricingAvailable
      ? number(position.gross_cost_value, Math.abs(quantity * number(costPrice))) * contractMultiplier
      : null;
    const marketValueBase = baseValuationAvailable ? nativeNetValue * fxToBase : null;
    const grossMarketValueBase = baseValuationAvailable ? nativeGrossValue * fxToBase : null;
    const pnlBase = baseValuationAvailable && Number.isFinite(nativeCostValue)
      ? (nativeNetValue - nativeCostValue) * fxToBase
      : null;
    const meta = getSymbolMetadata(position.symbol, position.market);

    return {
      symbol: position.symbol,
      ticker: String(position.symbol).split(".")[0],
      tvSymbol: meta.tvSymbol,
      group: meta.group,
      name: position.symbol_name || position.symbol,
      market: position.market || "",
      currency,
      quantity,
      grossQuantity,
      availableQuantity: number(position.available_quantity),
      direction: quantity > 0 ? "long" : quantity < 0 ? "short" : "hedged",
      hasOffsettingLegs: Boolean(position.has_offsetting_legs),
      costPrice: Number.isFinite(costPrice) ? costPrice : null,
      lastPrice,
      prevClose: Number.isFinite(prevClose) ? prevClose : null,
      changePercent:
        nativePricingAvailable && Number.isFinite(prevClose) && prevClose !== 0
          ? ((lastPrice - prevClose) / prevClose) * 100
          : null,
      marketValue: nativeNetValue,
      marketValueBase,
      grossMarketValueBase,
      pnlBase,
      pnlPercent:
        nativePricingAvailable && nativeGrossCostValue > 0 && Number.isFinite(nativeCostValue)
          ? ((nativeNetValue - nativeCostValue) / nativeGrossCostValue) * 100
          : null,
      netWeight:
        marketValueBase == null || netAssetsBase == null
          ? null
          : (marketValueBase / netAssetsBase) * 100,
      weight:
        grossMarketValueBase == null || netAssetsBase == null
          ? null
          : (Math.abs(grossMarketValueBase) / netAssetsBase) * 100,
      quoteTimestamp: mark?.timestamp ?? null,
      quoteSession: mark?.session ?? null,
      tradeStatus: quote?.trade_status ?? null,
      instrumentType,
      contractMultiplier: Number.isFinite(contractMultiplier) ? contractMultiplier : null,
      valuationStatus: baseValuationAvailable
        ? "priced"
        : nativePricingAvailable
          ? "native_only"
          : "unpriced",
      valuationLimitation: limitation,
    };
  });

  normalized.sort(
    (a, b) => (b.grossMarketValueBase ?? -1) - (a.grossMarketValueBase ?? -1),
  );

  const groupExposure = {};
  const groupNetExposure = {};
  for (const position of normalized) {
    if (position.weight != null) {
      groupExposure[position.group] = (groupExposure[position.group] ?? 0) + position.weight;
    }
    if (position.netWeight != null) {
      groupNetExposure[position.group] =
        (groupNetExposure[position.group] ?? 0) + position.netWeight;
    }
  }

  const pricedPositions = normalized.filter((position) => position.valuationStatus === "priced");
  const quotedPositions = normalized.filter((position) => position.lastPrice != null);
  const quoteTimes = quotedPositions
    .map((position) => position.quoteTimestamp)
    .filter(Boolean)
    .sort();
  const unpricedPositionCount = normalized.length - pricedPositions.length;
  const missingTimestampCount = pricedPositions.filter(
    (position) => !position.quoteTimestamp,
  ).length;
  const cleanQuoteErrors = quoteErrors.map((error) => String(error)).slice(0, 50);
  const cleanSourceErrors = normalizeSourceErrors(sourceErrors);
  const cleanSourceWarnings = normalizeSourceErrors(sourceWarnings);
  const valuationComplete =
    unpricedPositionCount === 0
    && missingTimestampCount === 0
    && cleanQuoteErrors.length === 0
    && cleanSourceErrors.length === 0
    && account.valuationComplete;

  return {
    source: "Longbridge MCP OAuth 2.1",
    status: valuationComplete ? "live" : "degraded",
    holdingsStatus: "live",
    valuationStatus: valuationComplete ? "complete" : "partial",
    syncedAt: new Date().toISOString(),
    quoteAsOf: quoteTimes[0] ?? null,
    quoteLatestAsOf: quoteTimes.at(-1) ?? null,
    account: {
      baseCurrency: account.currency,
      netAssets: account.netAssets,
      totalCash: account.totalCash,
      buyPower: account.buyPower,
      initMargin: account.initMargin,
      maintenanceMargin: account.maintenanceMargin,
      riskLevel: account.riskLevel,
      marginCall: account.marginCall,
      valuationComplete: account.valuationComplete,
      unconvertedCurrencies: account.unconvertedCurrencies,
      cashInfos: account.cashInfos.map((cash) => ({
        currency: cash.currency,
        availableCash: number(cash.available_cash),
        withdrawCash: number(cash.withdraw_cash),
        frozenCash: number(cash.frozen_cash),
        settlingCash: number(cash.settling_cash),
      })),
    },
    fx: {
      status: fxStatus,
      provider: cleanMetadataValue(fxMetadata.provider, 100),
      providerCode: cleanMetadataValue(fxMetadata.providerCode, 20),
      asOf: cleanMetadataValue(fxMetadata.asOf, 20),
      fetchedAt: cleanMetadataValue(fxMetadata.fetchedAt, 40),
      sourceUrl: cleanMetadataValue(fxMetadata.sourceUrl, 300),
      usage: cleanMetadataValue(fxMetadata.usage, 40),
      hkdPerUsd: nullableRate(findConversionRate("USD", "HKD", fxGraph)),
      currencyCount: fxGraph.size,
    },
    positions: normalized,
    groupExposure,
    groupNetExposure,
    totals: {
      positionCount: normalized.length,
      pricedPositionCount: pricedPositions.length,
      unpricedPositionCount,
      positionsNetMarketValueBase: pricedPositions.reduce(
        (sum, position) => sum + position.marketValueBase,
        0,
      ),
      positionsGrossMarketValueBase: pricedPositions.reduce(
        (sum, position) => sum + Math.abs(position.grossMarketValueBase),
        0,
      ),
      cashRatio:
        account.totalCash == null || netAssetsBase == null
          ? null
          : (account.totalCash / netAssetsBase) * 100,
      top1Weight: pricedPositions[0]?.weight ?? null,
      top5Weight: pricedPositions.length
        ? pricedPositions
          .slice(0, 5)
          .reduce((sum, position) => sum + (position.weight ?? 0), 0)
        : null,
    },
    dataQuality: {
      valuationComplete,
      unpricedPositionCount,
      missingTimestampCount,
      quoteErrors: cleanQuoteErrors,
      sourceErrors: cleanSourceErrors,
      sourceWarnings: cleanSourceWarnings,
      fxStatus,
      accountValuationComplete: account.valuationComplete,
      quoteAsOfPolicy: "oldest_available_native_mark",
    },
    orderWrite: false,
  };
}

export function inferInstrumentType(symbol) {
  const value = String(symbol ?? "").toUpperCase();
  const localCode = value.split(".")[0];
  return /\d{6}[CP]\d+$/.test(localCode) ? "option" : "equity";
}

export function flattenPositions(payload) {
  const list = payload?.list ?? payload ?? [];
  if (!Array.isArray(list)) return [];
  return list.flatMap((group) => {
    const channel = group?.account_channel ?? group?.channel ?? null;
    return (group?.stock_info ?? group?.positions ?? []).map((position) => ({
      ...position,
      account_channel: position.account_channel ?? channel,
    }));
  });
}

export function aggregatePositions(positions) {
  const grouped = new Map();
  for (const position of positions) {
    if (!position?.symbol) continue;
    const quantity = number(position.quantity);
    const costPrice = number(position.cost_price);
    const current = grouped.get(position.symbol) ?? {
      ...position,
      quantity: 0,
      available_quantity: 0,
      gross_quantity: 0,
      cost_value: 0,
      gross_cost_value: 0,
      has_positive_leg: false,
      has_negative_leg: false,
    };
    current.quantity += quantity;
    current.available_quantity += number(position.available_quantity);
    current.gross_quantity += Math.abs(quantity);
    current.cost_value += quantity * costPrice;
    current.gross_cost_value += Math.abs(quantity * costPrice);
    current.has_positive_leg ||= quantity > 0;
    current.has_negative_leg ||= quantity < 0;
    current.has_offsetting_legs = current.has_positive_leg && current.has_negative_leg;
    current.cost_price = current.quantity
      ? current.cost_value / current.quantity
      : current.gross_quantity
        ? current.gross_cost_value / current.gross_quantity
        : 0;
    grouped.set(position.symbol, current);
  }
  return [...grouped.values()];
}

export function selectQuoteMark(quote) {
  if (!quote || typeof quote !== "object") return null;
  const candidates = [
    quoteCandidate(quote, "regular"),
    quoteCandidate(quote.pre_market_quote, "pre_market"),
    quoteCandidate(quote.post_market_quote, "post_market"),
    quoteCandidate(quote.over_night_quote, "overnight"),
  ].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0))[0];
}

export function buildFxGraph(payload) {
  const exchanges = payload?.exchanges ?? payload?.list ?? payload ?? [];
  const graph = new Map();
  if (!Array.isArray(exchanges)) return graph;
  for (const item of exchanges) {
    // Internal FX rows are deliberately unambiguous: `rate` is the number of
    // `to_currency` units received for one `from_currency` unit. Provider
    // adapters in portfolio-service.mjs must translate their native contract
    // before data reaches this graph.
    const from = String(item.from_currency ?? "").toUpperCase();
    const to = String(item.to_currency ?? "").toUpperCase();
    const rate = number(item.rate, NaN);
    if (!from || !to || !(rate > 0)) continue;
    addFxEdge(graph, from, to, rate);
    addFxEdge(graph, to, from, 1 / rate);
  }
  return graph;
}

export function findConversionRate(fromCurrency, toCurrency, payloadOrGraph) {
  const from = String(fromCurrency ?? "").toUpperCase();
  const to = String(toCurrency ?? "").toUpperCase();
  if (!from || !to) return NaN;
  if (from === to) return 1;
  const graph = payloadOrGraph instanceof Map ? payloadOrGraph : buildFxGraph(payloadOrGraph);
  const queue = [{ currency: from, rate: 1 }];
  const visited = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    for (const [next, edgeRate] of graph.get(current.currency) ?? []) {
      if (visited.has(next)) continue;
      const rate = current.rate * edgeRate;
      if (next === to) return rate;
      visited.add(next);
      queue.push({ currency: next, rate });
    }
  }
  return NaN;
}

export function findHkdPerUsd(payload) {
  return findConversionRate("USD", "HKD", payload);
}

function normalizeQuoteList(payload) {
  if (Array.isArray(payload)) return payload;
  const list = payload?.list ?? payload?.quotes ?? payload?.option_quotes ?? [];
  if (!Array.isArray(list)) {
    throw new Error("Longbridge quote returned an invalid shape.");
  }
  return list;
}

function quoteCandidate(value, session) {
  if (!value || typeof value !== "object") return null;
  const price = number(value.last_done ?? value.price, NaN);
  if (!(price > 0)) return null;
  const timestamp = normalizeTimestamp(value.timestamp);
  return {
    price,
    timestamp,
    epoch: timestamp ? new Date(timestamp).getTime() : null,
    session,
  };
}

function nativeValuationLimitation({ symbol, instrumentType, mark, contractMultiplier }) {
  if (!mark) return `${symbol} 缺少可用报价；真实数量保留，但不计算市值与权重。`;
  if (instrumentType === "option" && !(contractMultiplier > 0)) {
    return `${symbol} 缺少 option_quote 合约乘数；不使用默认 100 进行猜测。`;
  }
  return null;
}

function aggregateBalances(balances, baseCurrency, fxGraph) {
  const unconvertedCurrencies = new Set();
  const convert = (value, currency) => {
    const sourceCurrency = String(currency || baseCurrency).toUpperCase();
    const rate = findConversionRate(sourceCurrency, baseCurrency, fxGraph);
    if (!(rate > 0)) {
      unconvertedCurrencies.add(sourceCurrency);
      return null;
    }
    return number(value) * rate;
  };
  const sumMetric = (field) => {
    const converted = balances.map((item) => convert(item[field], item.currency || baseCurrency));
    return converted.some((value) => value == null)
      ? null
      : converted.reduce((sum, value) => sum + value, 0);
  };
  const riskLevels = balances.map((item) => String(item.risk_level ?? "—"));
  const result = {
    currency: baseCurrency,
    netAssets: sumMetric("net_assets"),
    totalCash: sumMetric("total_cash"),
    buyPower: sumMetric("buy_power"),
    initMargin: sumMetric("init_margin"),
    maintenanceMargin: sumMetric("maintenance_margin"),
    marginCall: sumMetric("margin_call"),
    riskLevel: [...new Set(riskLevels)].join(" / "),
    cashInfos: balances.flatMap((item) => item.cash_infos ?? []),
  };
  return {
    ...result,
    valuationComplete: unconvertedCurrencies.size === 0 && result.netAssets > 0,
    unconvertedCurrencies: [...unconvertedCurrencies],
  };
}

function normalizeSourceErrors(errors) {
  return errors.slice(0, 20).map((error) => ({
    tool: String(error?.tool ?? "unknown").slice(0, 80),
    code: Number.isFinite(Number(error?.code)) ? Number(error.code) : null,
    kind: String(error?.kind ?? "tool").slice(0, 40),
    message: String(error?.message ?? "未知数据源错误").slice(0, 300),
  }));
}

function cleanMetadataValue(value, maxLength) {
  return value == null ? null : String(value).slice(0, maxLength);
}

function addFxEdge(graph, from, to, rate) {
  if (!graph.has(from)) graph.set(from, new Map());
  graph.get(from).set(to, rate);
}

function nullableRate(value) {
  return Number.isFinite(value) ? value : null;
}

export function normalizeCandles(payload) {
  const list = Array.isArray(payload) ? payload : payload?.list ?? payload?.candlesticks ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((bar) => ({
      timestamp: normalizeTimestamp(bar.timestamp),
      open: number(bar.open, NaN),
      high: number(bar.high, NaN),
      low: number(bar.low, NaN),
      close: number(bar.close, NaN),
      volume: number(bar.volume),
      tradeSession: bar.trade_session ?? "Intraday",
    }))
    .filter(
      (bar) =>
        Boolean(bar.timestamp)
        && [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value)),
    )
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

export function normalizeTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
