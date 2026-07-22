const SYMBOLS = {
  "AAPL.US": { tvSymbol: "NASDAQ:AAPL", group: "消费科技" },
  "AMD.US": { tvSymbol: "NASDAQ:AMD", group: "半导体" },
  "AVGO.US": { tvSymbol: "NASDAQ:AVGO", group: "半导体" },
  "DRAM.US": { tvSymbol: "AMEX:DRAM", group: "存储" },
  "GOOGL.US": { tvSymbol: "NASDAQ:GOOGL", group: "平台科技" },
  "MU.US": { tvSymbol: "NASDAQ:MU", group: "存储" },
  "PDD.US": { tvSymbol: "NASDAQ:PDD", group: "中概互联网" },
  "SKHY.US": { tvSymbol: "NASDAQ:SKHY", group: "存储" },
  "7709.HK": { tvSymbol: "HKEX:7709", group: "存储" },
};

export function getSymbolMetadata(symbol, market = "") {
  if (SYMBOLS[symbol]) return SYMBOLS[symbol];
  const ticker = String(symbol).split(".")[0];
  if (market === "HK" || symbol.endsWith(".HK")) {
    return { tvSymbol: `HKEX:${ticker}`, group: "其他" };
  }
  return { tvSymbol: ticker, group: "其他" };
}
