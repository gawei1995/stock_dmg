const TV_HOSTS = new Set([
  "tradingview.com",
  "www.tradingview.com",
  "cn.tradingview.com",
]);

const AUTH_POPUP_HOSTS = new Set([
  ...TV_HOSTS,
  "accounts.google.com",
  "appleid.apple.com",
]);

const GOOGLE_REDIRECT_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "google.com.hk",
  "www.google.com.hk",
  "google.cn",
  "www.google.cn",
]);

const MAX_EXTERNAL_URL_LENGTH = 4_096;

export function isTradingViewUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && TV_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedAuthPopup(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && AUTH_POPUP_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(value) {
  return Boolean(normalizeSafeExternalUrl(value));
}

export function normalizeSafeExternalUrl(value) {
  return normalizeSafeExternalUrlAtDepth(value, 0);
}

function normalizeSafeExternalUrlAtDepth(value, depth) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source || source.length > MAX_EXTERNAL_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(source)) {
    return null;
  }
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    if (GOOGLE_REDIRECT_HOSTS.has(url.hostname)
      && /^\/url\/?$/.test(url.pathname)
      && depth < 2) {
      const destination = url.searchParams.get("url") ?? url.searchParams.get("q");
      if (destination) return normalizeSafeExternalUrlAtDepth(destination, depth + 1);
    }
    const normalized = url.toString();
    return normalized.length <= MAX_EXTERNAL_URL_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}
