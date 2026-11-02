import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

export const BUNDLED_REVIEW_SKILLS = ["review-decision-cycles", "review-earnings-decisions"];
const SOURCE_ENTRIES = ["main.mjs", "preload.cjs", "renderer", "src", "assets", "scripts", "tests", "package.json", "package-lock.json"];
const RUNTIME_ENTRIES = ["main.mjs", "preload.cjs", "renderer", "src"];
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function inventoryFiles(root, entries, { allowSymlinks = false } = {}) {
  const files = [];
  async function visit(relative) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Inventory paths must remain inside their root.");
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    const name = relative.split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      if (!allowSymlinks) throw new Error(`Release source must not depend on an untracked symlink target: ${name}`);
      const target = await readlink(absolute);
      files.push({ path: name, kind: "symlink", target, sha256: sha256(target) });
    } else if (stat.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) {
        if (child !== ".DS_Store") await visit(path.join(relative, child));
      }
    } else if (stat.isFile()) {
      files.push({ path: name, kind: "file", bytes: stat.size, mode: stat.mode & 0o777, sha256: await hashFile(absolute) });
    } else throw new Error(`Unsupported release input: ${name}`);
  }
  for (const entry of entries) await visit(entry);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { algorithm: "sha256", treeHash: sha256(JSON.stringify(files)), files };
}

export async function sourceFingerprint(desktopRoot) {
  const source = await inventoryFiles(desktopRoot, SOURCE_ENTRIES);
  const runtime = await inventoryFiles(desktopRoot, RUNTIME_ENTRIES);
  const skillRoot = path.resolve(desktopRoot, "../trading-agent-workspace/.agents/skills");
  const skills = await inventoryFiles(skillRoot, BUNDLED_REVIEW_SKILLS);
  const dependencyLock = { path: "package-lock.json", sha256: await hashFile(path.join(desktopRoot, "package-lock.json")) };
  return { source, runtime, skills, dependencyLock,
    inputHash: sha256(JSON.stringify({ source: source.treeHash, skills: skills.treeHash, dependencyLock: dependencyLock.sha256 })) };
}

export function assertSameInputs(before, after) {
  if (before.inputHash !== after.inputHash) throw new Error("Release inputs changed while verification was running; rebuild and rerun the gate. No passing manifest was issued.");
}

export function assertPackagedContents(expected, packaged) {
  for (const [name, inventory] of [["runtime", expected.runtime], ["skills", expected.skills]]) {
    const actual = new Map((packaged[name] ?? []).map((file) => [file.path, file]));
    for (const file of inventory.files) {
      const built = actual.get(file.path);
      if (!built || built.sha256 !== file.sha256 || built.bytes !== file.bytes) throw new Error(`Packaged ${name} differs from the verified source: ${file.path}`);
      actual.delete(file.path);
    }
    if (actual.size) throw new Error(`Packaged ${name} contains unexpected files: ${[...actual.keys()].join(", ")}`);
  }
}

export async function readAppPackage(desktopRoot) {
  const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(desktopRoot, "package-lock.json"), "utf8"));
  if (packageJson.version !== lock.version || packageJson.version !== lock.packages?.[""]?.version) {
    throw new Error("App package and dependency lock versions disagree.");
  }
  for (const field of ["dependencies", "devDependencies"]) {
    if (JSON.stringify(packageJson[field] ?? {}) !== JSON.stringify(lock.packages?.[""]?.[field] ?? {})) {
      throw new Error(`App ${field} disagree with the dependency lock.`);
    }
  }
  return packageJson;
}

export function createReleaseManifest({ appPackage, fingerprint, git, codex, environment, steps, artifacts, packaged, target, createdAt = new Date().toISOString() }) {
  if (!steps.length || steps.some((step) => step.status !== "passed")) throw new Error("A release manifest requires every gate to pass.");
  for (const name of ["dependency-tree", "unit-tests", "source-ibkr-ui", "source-radar-ui", "source-review-ui", "source-health-ui", "source-research-ui", "package", "packaged-dependencies-and-content", "packaged-source-and-skill-hash-match", "packaged-ibkr-ui", "packaged-radar-ui", "packaged-review-ui", "packaged-health-ui", "packaged-research-ui", "artifact-integrity", "source-unchanged-during-verification"]) {
    if (!steps.some((step) => step.name === name)) throw new Error(`A required release gate is missing: ${name}`);
  }
  if (!artifacts.some((artifact) => artifact.type === "app_bundle") || target === "mac" && ["dmg", "zip"].some((type) => !artifacts.some((artifact) => artifact.type === type))) throw new Error("Required release artifacts are missing.");
  return {
    schemaVersion: 1, createdAt, status: "verified_local_build", releaseStatus: "not_published", target,
    reproducibility: "Source and dependency inputs are recorded; byte-identical DMG output is not promised because packaging metadata can vary.",
    app: { name: appPackage.name, productName: appPackage.build.productName, version: appPackage.version },
    source: { ...fingerprint.source, inputHash: fingerprint.inputHash, scope: "desktop runtime, assets, scripts, tests, package metadata; bundled review skills recorded separately", git },
    dependencyLock: fingerprint.dependencyLock,
    bundledSkills: { ...fingerprint.skills, policy: "Only bundled project review skills are hashed; global/user skills and credentials are neither read nor included." },
    runtimeVersions: environment,
    codex: { ...codex, compatibility: "App Server fixture/contract tests passed; no version-range claim and no live model/MCP invocation.", liveIntegration: "not_run" },
    packaged: { appVersion: packaged.appVersion, importedModuleCount: packaged.importedModuleCount, dependencies: packaged.dependencies, installedDependencies: packaged.installedDependencies },
    verification: steps, artifacts,
    distribution: { developerIdSigning: "not_performed", appleNotarization: "not_performed", status: "trusted_local_testing_only" },
    manualAcceptance: [
      { status: "pending", step: "核对本清单的源码、依赖锁、Skill 与产物 SHA-256；dirty 构建需同时保留源码工作区，Git commit 本身不足以复现。" },
      { status: "pending", step: "仅在用户确认后安装；确认版本、原 TV 登录/布局、原券商授权与历史会话未被迁移或清空。" },
      { status: "pending", step: "经用户许可分别验证长桥与 IBKR 只读连接、真实持仓、汇率来源、期权缺失状态；不下单。" },
      { status: "pending", step: "经用户许可完成一次真实 Codex 会话的流式返回、历史恢复和取消；本门禁没有消耗模型额度。" },
      { status: "pending", step: "检查 EOD/后台状态与复盘范围提示；模拟检查通过不等于已验证每晚真实行情和交易日覆盖。" },
    ],
  };
}
