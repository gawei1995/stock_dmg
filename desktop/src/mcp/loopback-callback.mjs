import { createServer } from "node:http";

const SUCCESS_HTML = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>长桥授权完成</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0f12;color:#e8f0f2;font:16px system-ui}.card{max-width:440px;padding:32px;border:1px solid #263139;border-radius:16px;background:#12181d}p{color:#9aabb4;line-height:1.7}</style>
<div class="card"><h1>长桥授权完成</h1><p>你可以关闭此页面并返回「交易驾驶舱」。应用只会调用账户、仓位和行情查询工具。</p></div>`;

export class OAuthLoopbackServer {
  constructor({ port = 37819, path = "/oauth/callback", timeoutMs = 5 * 60 * 1000 } = {}) {
    this.port = port;
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.server = null;
    this.pending = null;
    this.timer = null;
    this.expectedState = null;
  }

  get redirectUrl() {
    return `http://127.0.0.1:${this.port}${this.path}`;
  }

  setExpectedState(value) {
    this.expectedState = String(value || "");
  }

  async start() {
    if (this.server) return;
    this.pending = {};
    this.pending.promise = new Promise((resolve, reject) => {
      this.pending.resolve = (value) => {
        if (this.pending.settled) return;
        this.pending.settled = true;
        resolve(value);
      };
      this.pending.reject = (error) => {
        if (this.pending.settled) return;
        this.pending.settled = true;
        reject(error);
      };
    });

    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", this.redirectUrl);
      if (url.pathname !== this.path) {
        response.writeHead(404).end("Not found");
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" }).end("Method not allowed");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!this.expectedState || state !== this.expectedState) {
        response.writeHead(400, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end("Invalid OAuth state. The authorization window remains active.");
        return;
      }

      if (error || !code) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Longbridge authorization failed. Return to Trading Cockpit.");
        this.pending.reject(new Error(error || "Authorization code missing."));
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(SUCCESS_HTML);
      this.pending.resolve({ code, state });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (address && typeof address === "object") this.port = address.port;
    this.timer = setTimeout(() => {
      this.pending?.reject(new Error("Longbridge authorization timed out after 5 minutes."));
      void this.close();
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  waitForCallback() {
    if (!this.pending?.promise) {
      throw new Error("OAuth callback server has not started.");
    }
    return this.pending.promise;
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const current = this.server;
    this.server = null;
    if (!current) return;
    await new Promise((resolve) => current.close(resolve));
  }
}
