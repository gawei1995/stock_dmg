import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { findTwsApplication } from "../src/brokers/tws-application.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cockpit-tws-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { homeDirectory: path.join(root, "home"), systemApplicationsDirectory: path.join(root, "system") };
  const userRoot = path.join(options.homeDirectory, "Applications");
  async function bundle(name, { system = false, nested = true } = {}) {
    const installRoot = system ? options.systemApplicationsDirectory : userRoot;
    const target = nested ? path.join(installRoot, name, `${name}.app`) : path.join(installRoot, `${name}.app`);
    await mkdir(path.join(target, "Contents/MacOS"), { recursive: true });
    await writeFile(path.join(target, "Contents/Info.plist"), "synthetic application metadata");
    return target;
  }
  return { options, userRoot, bundle };
}

test("TWS launch discovers 10.50 over 10.30 and ignores incomplete older installs and uninstallers", async t => {
  const { options, userRoot, bundle } = await fixture(t);
  await bundle("Trader Workstation 10.30");
  await bundle("Trader Workstation");
  const newest = await bundle("Trader Workstation 10.50");
  await mkdir(path.join(userRoot, "Trader Workstation 10.99/.install4j"), { recursive: true });
  await bundle("Trader Workstation 10.99 Uninstaller", { nested: false });
  assert.deepEqual(await findTwsApplication(options), { path: newest, version: "10.50" });
});

test("TWS versions compare numerically across home/system and direct/nested bundle layouts", async t => {
  const { options, bundle } = await fixture(t);
  await bundle("Trader Workstation 10.9");
  await bundle("Trader Workstation 10.30", { nested: false });
  const latest = await bundle("Trader Workstation 10.50.1", { system: true, nested: false });
  assert.equal((await findTwsApplication(options)).path, latest);
  const userLatest = await bundle("Trader Workstation 10.50.1");
  assert.equal((await findTwsApplication(options)).path, userLatest, "same version prefers user install");
});

test("generic TWS is a fallback; missing or malformed applications do not become launch targets", async t => {
  const { options, userRoot, bundle } = await fixture(t);
  assert.equal(await findTwsApplication(options), null);
  const fallback = await bundle("Trader Workstation", { system: true, nested: false });
  await mkdir(path.join(userRoot, "Trader Workstation 10.50/Trader Workstation 10.50.app/Contents"), { recursive: true });
  await writeFile(path.join(userRoot, "Trader Workstation 10.50/Trader Workstation 10.50.app/Contents/Info.plist"), "no executable directory");
  assert.deepEqual(await findTwsApplication(options), { path: fallback, version: null });
  await assert.rejects(findTwsApplication({ ...options, homeDirectory: "relative" }), /绝对路径/);
});

test("TWS discovery does not traverse symlinks or unrelated applications", async t => {
  const { options, userRoot, bundle } = await fixture(t);
  const other = await bundle("Another Application");
  await symlink(other, path.join(userRoot, "Trader Workstation 99.99.app"));
  assert.equal(await findTwsApplication(options), null);
});

const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function loginHost({ target, error = "", trusted = true } = {}) {
  const calls = [], handlers = new Map();
  const context = vm.createContext({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    assertTrustedSender: () => { if (!trusted) throw new Error("untrusted"); },
    normalizeGatewayConfig: value => ({ transport: value?.transport ?? "tws", port: value?.port ?? 7496 }),
    app: { getPath: key => { assert.equal(key, "home"); return "/synthetic-home"; } },
    findTwsApplication: async options => { calls.push(["find", options.homeDirectory]); return target; },
    shell: {
      openPath: async value => { calls.push(["open", value]); return error; },
      openExternal: async value => { calls.push(["external", value]); },
    },
  });
  const start = main.indexOf('  ipcMain.handle("ibkr:login"');
  const end = main.indexOf('\n  ipcMain.handle(', start + 1);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(main.slice(start, end), context);
  return { calls, login: request => handlers.get("ibkr:login")({}, request) };
}

test("real login handler resolves a local install and never accepts an arbitrary renderer launch path", async () => {
  const host = loginHost({ target: { path: "/synthetic-home/Applications/Trader Workstation 10.50.app", version: "10.50" } });
  assert.equal((await host.login({ applicationPath: "/untrusted.app" })).ok, true);
  assert.deepEqual(host.calls, [["find", "/synthetic-home"], ["open", "/synthetic-home/Applications/Trader Workstation 10.50.app"]]);
  assert.doesNotMatch(main, /Applications\/Trader Workstation 10\.30/);
});

test("TWS missing/open failures stay explicit; gateway and sender validation remain independent", async () => {
  const absent = loginHost();
  await assert.rejects(absent.login(), /未找到标准位置/);
  assert.equal(absent.calls.length, 1);
  const failed = loginHost({ target: { path: "/known.app" }, error: "failed" });
  await assert.rejects(failed.login(), /未能自动打开/);
  assert.equal(failed.calls.length, 2, "does not launch a second old version after failure");
  const gateway = loginHost();
  await gateway.login({ transport: "gateway", port: 5001 });
  assert.deepEqual(gateway.calls, [["external", "https://localhost:5001"]]);
  const untrusted = loginHost({ trusted: false });
  await assert.rejects(untrusted.login(), /untrusted/);
  assert.equal(untrusted.calls.length, 0);
});
