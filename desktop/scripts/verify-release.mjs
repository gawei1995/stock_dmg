import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPackagedContents, assertSameInputs, createReleaseManifest, hashFile, inventoryFiles, readAppPackage, sha256, sourceFingerprint } from "./release-manifest.mjs";

export function parseReleaseArgs(args) {
  let target = "dir", plan = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--target" && ["dir", "mac"].includes(args[index + 1])) target = args[++index];
    else if (args[index] === "--plan") plan = true;
    else throw new Error(`Unknown release argument: ${args[index]}. Allowed: --target dir|mac, --plan.`);
  }
  return { target, plan };
}

export function releasePlan({ target = "dir", architecture = process.arch } = {}) {
  if (!["dir", "mac"].includes(target) || !["arm64", "x64"].includes(architecture)) throw new Error("Unsupported release target or architecture.");
  return [
    { name: "dependency-tree", tool: "npm", args: ["ls", "--omit=dev", "--all", "--json"], timeoutMs: 60_000 },
    { name: "unit-tests", tool: "node", args: ["--test", "tests/*.test.mjs"], timeoutMs: 10 * 60_000 },
    { name: "source-ibkr-ui", tool: "electron", args: ["tests/ibkr-ui-smoke.cjs"], timeoutMs: 60_000 },
    { name: "source-radar-ui", tool: "electron", args: ["tests/radar-ui-smoke.cjs"], timeoutMs: 60_000 },
    { name: "source-review-ui", tool: "electron", args: ["tests/review-stability-ui-smoke.cjs"], timeoutMs: 60_000 },
    { name: "source-health-ui", tool: "electron", args: ["tests/health-ui-smoke.cjs"], timeoutMs: 60_000 },
    { name: "source-research-ui", tool: "electron", args: ["tests/research-ui-smoke.cjs"], timeoutMs: 60_000 },
    { name: "package", tool: "builder", args: target === "mac" ? ["--mac", "dmg", "zip", `--${architecture}`] : ["--mac", "--dir", `--${architecture}`], timeoutMs: 20 * 60_000 },
    { name: "packaged-dependencies-and-content", tool: "electron-node", args: ["tests/release-packaged-smoke.cjs", "<built-app>", "<version>"], timeoutMs: 60_000 },
    { name: "packaged-ibkr-ui", tool: "electron", args: ["tests/ibkr-ui-smoke.cjs", "<packaged-renderer>"], timeoutMs: 60_000 },
    { name: "packaged-radar-ui", tool: "electron", args: ["tests/radar-ui-smoke.cjs", "<packaged-renderer>"], timeoutMs: 60_000 },
    { name: "packaged-review-ui", tool: "electron", args: ["tests/review-stability-ui-smoke.cjs", "<packaged-renderer>"], timeoutMs: 60_000 },
    { name: "packaged-health-ui", tool: "electron", args: ["tests/health-ui-smoke.cjs", "<packaged-renderer>"], timeoutMs: 60_000 },
    { name: "packaged-research-ui", tool: "electron", args: ["tests/research-ui-smoke.cjs", "<packaged-renderer>"], timeoutMs: 60_000 },
  ];
}

export function releaseEnvironment(base = process.env) {
  const env = { ...base, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of ["ELECTRON_RUN_AS_NODE", "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "CSC_IDENTITY", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) delete env[key];
  return env;
}

function runCommand(command, args, { cwd, env, timeoutMs, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", timedOut = false, hardKill;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true; child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000); hardKill.unref();
    }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += data; if (!quiet) process.stdout.write(data); });
    child.stderr.on("data", (data) => { stderr += data; if (!quiet) process.stderr.write(data); });
    child.on("error", (error) => { clearTimeout(timer); clearTimeout(hardKill); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(hardKill);
      if (timedOut || code !== 0) reject(new Error(`${path.basename(command)} failed (${timedOut ? "timeout" : signal ?? code}). ${stderr.slice(-2_000)}`));
      else resolve({ stdout, stderr });
    });
  });
}

function gitMetadata(root) {
  const run = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5_000 });
  const head = run(["rev-parse", "HEAD"]), status = run(["status", "--porcelain", "--untracked-files=normal"]);
  return head.status === 0 && status.status === 0
    ? { available: true, commit: head.stdout.trim(), dirty: Boolean(status.stdout.trim()), statusHash: sha256(status.stdout),
      reproducibility: status.stdout.trim() ? "commit_plus_recorded_worktree_files_required" : "recorded_commit_and_inputs" }
    : { available: false, commit: null, dirty: null, reproducibility: "recorded_worktree_files_required" };
}

async function codexMetadata() {
  const { resolveCodexExecutable } = await import("../src/engine/codex-workspace.mjs");
  const executable = await resolveCodexExecutable();
  if (!executable) return { observedVersion: null, probe: "not_installed", warning: "Codex live integration requires a separately installed and authenticated local host." };
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return { observedVersion: result.status === 0 ? result.stdout.trim().slice(0, 200) : null,
    probe: result.status === 0 ? "version_only" : "version_probe_failed", executableSha256: await hashFile(executable) };
}

export async function verifyRelease({ desktopRoot, target = "dir" }) {
  if (process.platform !== "darwin") throw new Error("The desktop macOS release gate must run on macOS; source-only tests are not a release verification.");
  const appPackage = await readAppPackage(desktopRoot), startedAt = new Date();
  const before = await sourceFingerprint(desktopRoot), git = gitMetadata(desktopRoot), codex = await codexMetadata();
  const env = releaseEnvironment(), steps = [], plan = releasePlan({ target });
  const releaseDirectory = path.join(desktopRoot, "release");
  const appPath = path.join(releaseDirectory, process.arch === "arm64" ? "mac-arm64" : "mac", `${appPackage.build.productName}.app`);
  const packagedRenderer = path.join(appPath, "Contents/Resources/app.asar/renderer");
  let packaged;
  async function verifyStep(name, task, details = {}) {
    process.stdout.write(`\n[verify:release] ${name}\n`);
    const began = Date.now();
    const value = await task();
    steps.push({ name, status: "passed", durationMs: Date.now() - began, ...details });
    return value;
  }
  for (const step of plan) {
    let args = step.args.map((arg) => arg === "<built-app>" ? appPath : arg === "<version>" ? appPackage.version : arg === "<packaged-renderer>" ? packagedRenderer : arg);
    if (step.tool === "node") args = ["--test", ...(await readdir(path.join(desktopRoot, "tests"))).filter((file) => file.endsWith(".test.mjs")).sort().map((file) => `tests/${file}`)];
    if (step.tool === "electron" || step.tool === "electron-node") args = ["node_modules/electron/cli.js", ...args];
    if (step.tool === "builder") args = ["node_modules/electron-builder/cli.js", ...args];
    const result = await verifyStep(step.name, () => runCommand(step.tool === "npm" ? "npm" : process.execPath, args, {
      cwd: desktopRoot, env: step.tool === "electron-node" ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
      timeoutMs: step.timeoutMs, quiet: step.tool === "electron-node" || step.tool === "npm",
    }), { isolation: step.tool.startsWith("electron") ? "synthetic_profile_no_broker_or_model_requests" : "local_build_or_tests" });
    if (step.tool === "electron-node") {
      packaged = JSON.parse(result.stdout.trim());
      if (packaged.electronVersion !== appPackage.devDependencies.electron) throw new Error("Installed Electron runtime differs from its pinned package version.");
      for (const [name, version] of Object.entries(appPackage.dependencies)) {
        if (packaged.installedDependencies?.[name] !== version) throw new Error(`Packaged dependency does not match its pinned version: ${name}`);
      }
      await verifyStep("packaged-source-and-skill-hash-match", async () => assertPackagedContents(before, packaged));
    }
    if (step.tool === "npm") steps.at(-1).treeSha256 = sha256(result.stdout);
  }
  const artifacts = [];
  await verifyStep("artifact-integrity", async () => {
    const appInventory = await inventoryFiles(appPath, ["Contents"], { allowSymlinks: true });
    artifacts.push({ path: path.relative(desktopRoot, appPath), type: "app_bundle", treeHash: appInventory.treeHash, fileCount: appInventory.files.length });
    if (target === "mac") {
      const artifactNames = (await readdir(releaseDirectory)).filter((name) => name.startsWith(`${appPackage.build.productName}-${appPackage.version}-`) && (name.endsWith(".dmg") || name.endsWith(".zip")) && name.includes(process.arch));
      if (artifactNames.filter((name) => name.endsWith(".dmg")).length !== 1 || artifactNames.filter((name) => name.endsWith(".zip")).length !== 1) throw new Error("Expected exactly one current-version DMG and ZIP for this architecture.");
      for (const name of artifactNames.sort()) {
        const absolute = path.join(releaseDirectory, name), info = await stat(absolute);
        if (info.mtimeMs < startedAt.getTime() - 2_000) throw new Error(`Artifact predates this gate: ${name}`);
        await runCommand(name.endsWith(".dmg") ? "/usr/bin/hdiutil" : "/usr/bin/unzip", name.endsWith(".dmg") ? ["verify", absolute] : ["-t", absolute], { cwd: desktopRoot, env, timeoutMs: 120_000 });
        artifacts.push({ path: `release/${name}`, type: name.endsWith(".dmg") ? "dmg" : "zip", bytes: info.size, sha256: await hashFile(absolute) });
      }
    }
  });
  await verifyStep("source-unchanged-during-verification", async () => assertSameInputs(before, await sourceFingerprint(desktopRoot)));
  const manifest = createReleaseManifest({ appPackage, fingerprint: before, git, codex, target, steps, artifacts, packaged,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, electron: appPackage.devDependencies.electron },
  });
  await mkdir(releaseDirectory, { recursive: true });
  const file = path.join(releaseDirectory, `verification-${appPackage.version}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`\nRelease gate passed. Not published or installed. Manifest: ${file}\n`);
  return { manifest, file };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseReleaseArgs(process.argv.slice(2));
    if (options.plan) process.stdout.write(`${JSON.stringify(releasePlan(options), null, 2)}\n`);
    else await verifyRelease({ desktopRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ...options });
  } catch (error) {
    process.stderr.write(`Release gate FAILED; no passing manifest issued. ${error.stack}\n`); process.exitCode = 1;
  }
}
