import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isAllowedAuthPopup,
  isSafeExternalUrl,
  isTradingViewUrl,
  normalizeSafeExternalUrl,
} from "../src/security/navigation.mjs";

test("TradingView navigation is exact-host allowlisted", () => {
  assert.equal(isTradingViewUrl("https://www.tradingview.com/chart/abc"), true);
  assert.equal(isTradingViewUrl("https://tradingview.com/chart/"), true);
  assert.equal(isTradingViewUrl("https://tradingview.com.evil.example/chart"), false);
  assert.equal(isTradingViewUrl("http://www.tradingview.com/chart/"), false);
});

test("auth popups and external links remain HTTPS-only", () => {
  assert.equal(isAllowedAuthPopup("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(isAllowedAuthPopup("https://evil.example"), false);
  assert.equal(isSafeExternalUrl("https://www.sec.gov/Archives/example.htm"), true);
  assert.equal(isSafeExternalUrl("http://www.sec.gov/Archives/example.htm"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("data:text/html,hello"), false);
  assert.equal(isSafeExternalUrl("file:///tmp/report"), false);
  assert.equal(isSafeExternalUrl("https://user:password@example.com/report"), false);
  assert.equal(isSafeExternalUrl("https://example.com/line\nbreak"), false);
});

test("safe Google redirect links unwrap only to another valid HTTPS URL", () => {
  const target = "https://www.sec.gov/Archives/report_(Q2).htm?x=1&y=2";
  const redirect = `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U`;
  assert.equal(normalizeSafeExternalUrl(redirect), target);
  assert.equal(
    normalizeSafeExternalUrl("https://www.google.com/url?q=javascript%3Aalert%281%29"),
    null,
  );
  assert.equal(
    normalizeSafeExternalUrl("https://www.google.com/search?q=Alphabet+earnings"),
    "https://www.google.com/search?q=Alphabet+earnings",
  );
});

test("renderer external links cross a main-process validation boundary", async () => {
  const [main, preload] = await Promise.all([
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
  ]);
  assert.match(preload, /openExternal:\s*\(url\)\s*=>\s*ipcRenderer\.invoke\("external:open",\s*url\)/);
  assert.match(
    main,
    /ipcMain\.handle\("external:open"[\s\S]{0,500}assertTrustedSender\(event\)[\s\S]{0,500}normalizeSafeExternalUrl\(value\)[\s\S]{0,500}shell\.openExternal\(target\)/,
  );
});
