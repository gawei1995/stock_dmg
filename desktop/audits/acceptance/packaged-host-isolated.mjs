// External acceptance driver; not part of the frozen release or production
// harness. Runs the actual packaged executable, pauses before main execution,
// and installs isolation BEFORE application startup. See Electron's official
// https://www.electronjs.org/docs/latest/tutorial/debugging-main-process
// No real broker, model, login-item changes, or user profile may be accessed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryFiles, hashFile } from "../../scripts/release-manifest.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = path.join(desktop, "release/mac-arm64/交易驾驶舱.app");
const binary = path.join(appPath, "Contents/MacOS/交易驾驶舱");
const output = await mkdtemp(path.join(os.tmpdir(), "cockpit-packaged-host-"));
const profile = path.join(output, "profile"), workspace = path.join(output, "workspace");
await mkdir(profile); await mkdir(workspace);
const sentinel = `synthetic-isolated-restart-${randomUUID()}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), output,
  kind: "actual_packaged_host_with_instrumented_external_boundaries",
  liveBrokerCalls: false, liveModelCalls: false, userProfileRead: false,
  loginItemChanges: false, installed: false, nativeKeychainUsedForSyntheticCiphertext: true, runs: [] };
const manifestPath = path.join(desktop, "release/verification-0.24.6-2026-09-17T17-56-44-579Z.json");
const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
const expectedApp = manifest.artifacts.find(item=>item.type === 'app_bundle');
async function verifyPackagedTree() {
  const tree=await inventoryFiles(appPath,["Contents"],{allowSymlinks:true});
  assert.equal(tree.treeHash,expectedApp.treeHash,"actual launched .app differs from verified release");
  assert.equal(tree.files.length,expectedApp.fileCount);
  return {treeHash:tree.treeHash,fileCount:tree.files.length};
}

class Inspector {
  constructor(url) {
    this.socket = new WebSocket(url); this.next = 0; this.pending = new Map(); this.events = [];
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Inspector connection timeout")), 10_000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Inspector connection failed")); }, { once: true });
      this.socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Inspector connection closed")); }, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else this.events.push(message);
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression: `globalThis.__cockpitAcceptanceEvaluation = (${expression})`,
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async event(name) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const index = this.events.findIndex(event => event.method === name);
      if (index >= 0) return this.events.splice(index, 1)[0].params;
      await sleep(25);
    }
    throw new Error(`Inspector event missing: ${name}`);
  }
  close() { this.socket.close(); }
}

function isolationExpression() {
  return `(() => {
    const mod = process.getBuiltinModule('module');
    const req = mod.createRequire(process.resourcesPath + '/app.asar/package.json');
    const e = req('electron');
    if (e.app.isReady()) throw Error('Refuse isolation after app.ready');
    e.app.setPath('userData', ${JSON.stringify(profile)});
    e.app.setPath('sessionData', ${JSON.stringify(profile)});
    if (e.app.getPath('userData') !== ${JSON.stringify(profile)}) throw Error('Profile isolation failed');
    const record = globalThis.__cockpitAcceptance = {
      profile: e.app.getPath('userData'), session: e.app.getPath('sessionData'),
      loginIntent: [], blockedProcesses: [], blockedNetwork: [], errors: [], dialogs: [],
      appVersion: e.app.getVersion(), isPackaged: e.app.isPackaged,
      startedAt: Date.now(), require: req, electron: e,
    };
    e.app.setLoginItemSettings = settings => record.loginIntent.push({ ...settings });
    e.app.getLoginItemSettings = () => ({ openAtLogin: false, openAsHidden: false, wasOpenedAtLogin: false });
    e.app.relaunch = () => { throw Error('Isolated acceptance blocks relaunch'); };
    const denied = (kind, label = '') => { record.blockedNetwork.push({kind,label}); throw Error('Isolated acceptance blocks ' + kind); };
    e.shell.openExternal = async () => denied('external-browser');
    e.shell.openPath = async () => denied('external-app');
    e.net.fetch = async () => denied('electron-fetch');
    globalThis.fetch = async () => denied('node-fetch');
    for (const protocol of ['http','https']) {
      const api = req('node:' + protocol);
      for (const method of ['request','get']) api[method] = () => denied(protocol + '-' + method);
    }
    req('node:net').Socket.prototype.connect = function () { return denied('node-socket'); };
    req('node:tls').connect = () => denied('node-tls');
    const cp = req('node:child_process');
    for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
      cp[method] = command => { record.blockedProcesses.push({method, executable: req('node:path').basename(String(command))}); throw Error('Isolated acceptance blocks subprocess'); };
    }
    mod.syncBuiltinESMExports();
    e.dialog.showErrorBox = (title, content) => record.dialogs.push({title,content});
    e.dialog.showMessageBox = async () => ({ response: 0 });
    e.dialog.showOpenDialog = async () => ({canceled:true,filePaths:[]});
    e.dialog.showSaveDialog = async () => ({canceled:true});
    const sessions = new WeakSet();
    const guardSession = value => {
      if (sessions.has(value)) return; sessions.add(value);
      value.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        const network = /^(?:https?|wss?|ftp):/i.test(details.url);
        if (network) record.blockedNetwork.push({kind:'chromium',label:new URL(details.url).hostname});
        callback({cancel:network});
      });
    };
    e.app.on('session-created', guardSession);
    e.app.whenReady().then(() => guardSession(e.session.defaultSession));
    e.app.on('web-contents-created', (_event, contents) => {
      contents.on('preload-error', (_event, _preload, error) => record.errors.push(String(error?.message ?? error)));
      contents.on('render-process-gone', (_event, details) => record.errors.push('renderer:' + details.reason));
    });
    process.on('unhandledRejection', error => record.errors.push(String(error?.message ?? error)));
    return { profile:record.profile,session:record.session,appVersion:record.appVersion,isPackaged:record.isPackaged,ready:e.app.isReady() };
  })()`;
}

async function run(phase, expectedId = null) {
  const start = Date.now();
  const env = { ...process.env, TRADING_COCKPIT_CODEX_WORKSPACE: workspace, TRADING_COCKPIT_CODEX_BIN: "/usr/bin/false" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${profile}`,
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--disable-background-networking"], {
    cwd: output, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", inspector, terminal = null, step = "launch";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const exited = new Promise(resolve => {
    child.once("exit", (code, signal) => { terminal = { code, signal }; resolve(terminal); });
    child.once("error", error => { terminal = { code: null, signal: null, error: error.message }; resolve(terminal); });
  });
  try {
    const connectUntil = Date.now() + 10_000;
    let url;
    while (!(url = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0])) {
      if (terminal || Date.now() >= connectUntil) throw new Error(`Packaged inspector unavailable: ${stderr.slice(-1200)}`);
      await sleep(25);
    }
    inspector = new Inspector(url);
    step = "enable-debugger";
    await inspector.call("Debugger.enable");
    await inspector.call("Runtime.runIfWaitingForDebugger");
    const pause = await inspector.event("Debugger.paused");
    assert.equal(pause.reason, "Break on start");
    assert.equal(pause.callFrames[0]?.location.lineNumber, 0);
    assert.equal(pause.callFrames[0]?.location.columnNumber, 0);
    const scriptId = pause.callFrames[0].location.scriptId;
    const parsed = inspector.events.find(event => event.method === "Debugger.scriptParsed" && event.params.scriptId === scriptId)?.params;
    const pausedSource = await inspector.call("Debugger.getScriptSource", { scriptId });
    const firstPause = { reason: pause.reason, url: parsed?.url ?? null,
      sourceSha256: sha256(pausedSource.scriptSource),
      sourcePrefix: pausedSource.scriptSource.slice(0, 500) };
    assert.equal(fileURLToPath(firstPause.url), path.join(appPath, "Contents/Resources/app.asar/src/security/encrypted-store.mjs"));
    assert.equal(firstPause.sourceSha256, manifest.source.files.find(file => file.path === "src/security/encrypted-store.mjs")?.sha256,
      "pause must precede business startup in the frozen, side-effect-free entry dependency");
    await writeFile(path.join(output, `${phase}-pause.json`), JSON.stringify({
      ...firstPause, frames: pause.callFrames.map(frame=>({functionName:frame.functionName,url:frame.url,location:frame.location})),
    },null,2));
    step = "install-isolation-before-main";
    const evaluated = await inspector.call("Debugger.evaluateOnCallFrame", {
      callFrameId: pause.callFrames[0].callFrameId, expression: isolationExpression(), returnByValue: true,
    });
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
    const isolation = evaluated.result?.value;
    assert.equal(isolation.profile, profile); assert.equal(isolation.session, profile);
    assert.equal(isolation.ready, false); assert.equal(isolation.isPackaged, true);
    assert.equal(isolation.appVersion, "0.24.6");
    await inspector.call("Debugger.resume");
    await sleep(150);
    step = "wait-main-renderer-and-bootstrap";
    const until = Date.now() + 20_000;
    let bootstrap;
    const inRenderer = script => inspector.evaluate(`(async () => {
      const s=globalThis.__cockpitAcceptance;const w=s.electron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));
      if(!w || w.webContents.isLoadingMainFrame()) return null;
      return w.webContents.executeJavaScript(${JSON.stringify(script)});
    })()`);
    while (!bootstrap) {
      if (terminal || Date.now() >= until) throw new Error(`Packaged startup incomplete: ${stderr.slice(-1800)}`);
      try {
        bootstrap = await inRenderer(`typeof cockpit==='undefined' ? null : cockpit.getInitialState().then(x=>({
          connected:x.longbridge?.connected,savedAuthorization:x.longbridge?.hasSavedAuthorization,
          portfolioPresent:!!x.portfolio,orderWrite:x.safeguards?.orderWrite,storage:x.storage,
          reviewSkills:x.reviewSkills?.status,codex:x.codex?.state
        }))`);
      } catch(error) {
        if(!/Promise was collected|Execution context was destroyed/.test(error.message)) throw error;
        if(terminal) throw error;
        await sleep(100);
      }
      if (!bootstrap) await sleep(100);
    }
    const startupMs = Date.now() - start;
    step = "assert-empty-bootstrap";
    assert.equal(bootstrap.connected, false); assert.equal(bootstrap.savedAuthorization, false);
    assert.equal(bootstrap.portfolioPresent, false); assert.equal(bootstrap.orderWrite, false);
    assert.equal(bootstrap.storage.encrypted, true); assert.equal(bootstrap.reviewSkills, "ready");
    let cycleId = expectedId;
    if (phase === "write") {
      step = "save-synthetic-cycle-through-preload";
      const created = await inRenderer(`cockpit.review.createCycle(${JSON.stringify({
        type: "position_lifecycle", title: sentinel, symbols: ["AAPL.US"],
        startAt: "2026-09-01T14:30:00Z", endAt: "2026-09-15T20:00:00Z",
        startCondition: "合成验收数据，不是真实交易", endCondition: "重启核对结束",
      })}).then(x=>({ok:x.ok,id:x.cycle?.id,title:x.cycle?.title}))`);
      assert.equal(created.ok, true); assert.equal(created.title, sentinel);
      cycleId = created.id; assert.equal(typeof cycleId, "string");
    }
    step = "read-synthetic-cycle-through-preload";
    const saved = await inRenderer(`cockpit.review.snapshot().then(x=>({
      cycles:x.cycles?.map(c=>({id:c.id,title:c.title})),
      count:x.cycles?.length,accountScopeVerified:x.portfolioSnapshots?.accountScopeVerified
    }))`);
    assert.equal(saved.count, 1);
    assert.deepEqual(saved.cycles, [{ id: cycleId, title: sentinel }]);
    step = "read-health-and-capture";
    const health = await inRenderer(`cockpit.health.snapshot().then(x=>({schemaVersion:x.schemaVersion,sections:x.sections?.map(s=>({id:s.id,state:s.state}))}))`);
    assert.ok(health.sections?.some(section => section.id === "storage"));
    assert.equal(health.sections.find(section => section.id === "storage").state, "healthy");
    await inRenderer(`document.querySelector('#workspace-review').click(); true`);
    await sleep(150);
    const observations = await inspector.evaluate(`(async () => {
      const s=globalThis.__cockpitAcceptance;const e=s.electron;
      const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));
      await s.require('node:fs/promises').writeFile(${JSON.stringify(path.join(output, `${phase}.png`))},(await w.webContents.capturePage()).toPNG());
      return {appVersion:s.appVersion,profile:s.profile,session:s.session,loginIntent:s.loginIntent,
        blockedProcesses:s.blockedProcesses,blockedNetwork:s.blockedNetwork,errors:s.errors,dialogs:s.dialogs,
        safeStorageAvailable:e.safeStorage.isEncryptionAvailable()};
    })()`);
    assert.equal(observations.safeStorageAvailable, true);
    assert.deepEqual(observations.errors, []); assert.deepEqual(observations.dialogs, []);
    assert.ok(observations.loginIntent.length >= 1);
    assert.ok(observations.loginIntent.every(value => value.openAtLogin === false));
    assert.ok(observations.blockedProcesses.length >= 1, "eager Codex startup must exercise the subprocess guard");
    assert.ok(observations.blockedProcesses.every(value => value.executable === "false"));
    assert.ok(observations.blockedNetwork.every(value => value.kind === "chromium" && /(^|\.)tradingview\.com$/.test(value.label)));
    step = "guarded-shutdown";
    await inspector.evaluate("(()=>{setTimeout(()=>globalThis.__cockpitAcceptance.electron.app.quit(),0);return true;})()");
    inspector.close(); inspector = null;
    const shutdown = await Promise.race([exited, sleep(10_000).then(() => null)]);
    assert.ok(shutdown, "guarded app shutdown must finish"); assert.equal(shutdown.code, 0);
    const ciphertext = await readFile(path.join(profile, "review-data.bin"));
    assert.equal(ciphertext.includes(Buffer.from(sentinel)), false, "synthetic note must not appear in plaintext");
    const result = { phase, startupMs, durationMs: Date.now() - start, cycleId, firstPause,
      ciphertext: { bytes: ciphertext.length, sha256: sha256(ciphertext), plaintextAbsent: true },
      bootstrap, health, observations, shutdown };
    await writeFile(path.join(output, `${phase}-stdout.log`), stdout);
    await writeFile(path.join(output, `${phase}-stderr.log`), stderr);
    return result;
  } catch(error) {
    await writeFile(path.join(output, `${phase}-stdout.log`), stdout);
    await writeFile(path.join(output, `${phase}-stderr.log`), stderr);
    throw new Error(`${phase} / ${step}: ${error.message}`, {cause:error});
  } finally {
    inspector?.close();
    if (!terminal) { child.kill("SIGTERM"); await Promise.race([exited,sleep(2000)]); if(!terminal) child.kill("SIGKILL"); }
  }
}

try {
  report.release = { version:manifest.app.version, inputHash:manifest.source.inputHash,
    manifestSha256:await hashFile(manifestPath), treeBefore:await verifyPackagedTree(),
    driverSha256:await hashFile(fileURLToPath(import.meta.url)) };
  report.runs.push(await run("write"));
  report.runs.push(await run("restart", report.runs[0].cycleId));
  assert.equal(report.runs[0].ciphertext.sha256, report.runs[1].ciphertext.sha256, "restart must not rewrite unchanged review evidence");
  report.files = (await readdir(profile)).filter(name=>name.endsWith('.bin'));
  report.release.treeAfter=await verifyPackagedTree();
  report.status = "passed";
} catch(error) {
  report.status = "failed"; report.error = error.stack;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output,"report.json"), JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
}
