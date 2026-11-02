import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { assertPackagedContents, assertSameInputs, createReleaseManifest, inventoryFiles, readAppPackage, sha256 } from "../scripts/release-manifest.mjs";
import { parseReleaseArgs, releaseEnvironment, releasePlan } from "../scripts/verify-release.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "cockpit-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const passedSteps = () => [
  ...releasePlan().map((step) => ({ name: step.name, status: "passed" })),
  ...["packaged-source-and-skill-hash-match", "artifact-integrity", "source-unchanged-during-verification"].map((name) => ({ name, status: "passed" })),
];
function manifestFixture() {
  return { appPackage: { name: "cockpit", version: "0.24.1", build: { productName: "交易驾驶舱" } },
    fingerprint: { source: { files: [], treeHash: "source" }, inputHash: "input", skills: { files: [], treeHash: "skills" }, dependencyLock: { sha256: "lock" } },
    git: { commit: "abc", dirty: true }, codex: { observedVersion: "codex-cli fixture", probe: "version_only" },
    environment: { node: "fixture", architecture: "arm64" }, steps: passedSteps(),
    artifacts: [{ path: "release/mac-arm64/cockpit.app", type: "app_bundle", treeHash: "app" }],
    packaged: { appVersion: "0.24.1", importedModuleCount: 50 }, target: "dir", createdAt: "2026-09-18T00:00:00Z" };
}

test("release gate requires tests, source and packaged UI, packaged dependencies and no recursive build scripts", () => {
  for (const target of ["dir", "mac"]) {
    const plan = releasePlan({ target, architecture: "arm64" });
    assert.ok(plan.findIndex((step) => step.name === "unit-tests") < plan.findIndex((step) => step.name === "package"));
    assert.equal(plan.filter((step) => step.name.startsWith("source-") && step.name.endsWith("-ui")).length, 5);
    assert.equal(plan.filter((step) => step.name.startsWith("packaged-") && step.name.endsWith("-ui")).length, 5);
    assert.equal(plan.find((step) => step.name === "package").tool, "builder");
    assert.ok(plan.every((step) => !step.args.some((arg) => ["dist:mac", "pack", "verify:release"].includes(arg))));
    assert.ok(plan.every((step) => Number.isFinite(step.timeoutMs) && step.timeoutMs > 0));
  }
  assert.deepEqual(parseReleaseArgs([]), { target: "dir", plan: false });
  assert.deepEqual(parseReleaseArgs(["--target", "mac", "--plan"]), { target: "mac", plan: true });
  for (const args of [["--skip-tests"], ["--target", "linux"], ["--no-ui"]]) assert.throws(() => parseReleaseArgs(args));
});

test("production scripts use the desktop gate and the original website requires explicit prototype commands", async () => {
  const desktop = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const root = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(desktop.scripts["verify:release"], /scripts\/verify-release\.mjs/);
  for (const name of ["pack", "dist:mac"]) assert.match(desktop.scripts[name], /verify-release\.mjs/);
  for (const name of ["dev", "build", "start", "test"]) assert.match(root.scripts[name], /--prefix desktop/);
  assert.equal(root.scripts["verify:release"], "node desktop/scripts/verify-release.mjs");
  for (const name of ["prototype:dev", "prototype:build", "prototype:start"]) assert.match(root.scripts[name], /vinext/);
  assert.match(root.scripts["prototype:test"], /prototype:build/);
});

test("release environment disables signing discovery and never passes signing/notarization credentials to the builder", () => {
  const source = { PATH: "/fixture", ELECTRON_RUN_AS_NODE: "1", CSC_LINK: "secret", CSC_KEY_PASSWORD: "secret", APPLE_ID: "private", APPLE_API_KEY: "secret", CSC_IDENTITY_AUTO_DISCOVERY: "true" };
  const env = releaseEnvironment(source);
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  for (const field of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_API_KEY", "ELECTRON_RUN_AS_NODE"]) assert.equal(env[field], undefined);
  assert.equal(source.CSC_LINK, "secret"); assert.equal(env.PATH, "/fixture");
});

test("source inventory is deterministic, notices content changes and never follows symlinks outside release inputs", async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested/b.txt"), "beta");
  await writeFile(path.join(root, "a.txt"), "alpha");
  const one = await inventoryFiles(root, ["nested", "a.txt"]), two = await inventoryFiles(root, ["a.txt", "nested"]);
  assert.deepEqual(one, two); assert.equal(one.files[0].sha256, sha256("alpha"));
  await writeFile(path.join(root, "a.txt"), "changed");
  assert.notEqual((await inventoryFiles(root, ["a.txt", "nested"])).treeHash, one.treeHash);
  await symlink(path.join(root, "a.txt"), path.join(root, "linked"));
  await assert.rejects(inventoryFiles(root, ["linked"]), /symlink/);
  await assert.rejects(inventoryFiles(root, ["../outside"]), /inside/);
  assert.throws(() => assertSameInputs({ inputHash: "before" }, { inputHash: "after" }), /changed/);
});

test("packaged content must exactly match verified runtime and bundled skill bytes", () => {
  const file = { path: "main.mjs", bytes: 4, sha256: "123" }, skill = { path: "review/SKILL.md", bytes: 5, sha256: "456" };
  const expected = { runtime: { files: [file] }, skills: { files: [skill] } };
  assert.doesNotThrow(() => assertPackagedContents(expected, { runtime: [file], skills: [skill] }));
  assert.throws(() => assertPackagedContents(expected, { runtime: [{ ...file, sha256: "wrong" }], skills: [skill] }), /differs/);
  assert.throws(() => assertPackagedContents(expected, { runtime: [file], skills: [] }), /Skill|skills/);
  assert.throws(() => assertPackagedContents(expected, { runtime: [file, { ...file, path: "unexpected.mjs" }], skills: [skill] }), /unexpected/);
});

test("package metadata must match the locked version and dependencies", async (t) => {
  const root = await temporary(t), pkg = { version: "1.0.0", dependencies: { example: "1.0.0" } };
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  const lock = { version: pkg.version, packages: { "": pkg } };
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  assert.equal((await readAppPackage(root)).version, "1.0.0");
  lock.packages[""].dependencies.example = "2.0.0";
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  await assert.rejects(readAppPackage(root), /dependencies disagree/);
});

test("manifest records dirty inputs and pending manual acceptance without claiming publication or live compatibility", () => {
  const input = manifestFixture(), manifest = createReleaseManifest(input);
  assert.equal(manifest.status, "verified_local_build"); assert.equal(manifest.releaseStatus, "not_published");
  assert.equal(manifest.source.git.dirty, true); assert.equal(manifest.source.inputHash, "input");
  assert.equal(manifest.codex.liveIntegration, "not_run"); assert.match(manifest.codex.compatibility, /no version-range claim/);
  assert.ok(manifest.manualAcceptance.every((step) => step.status === "pending"));
  assert.equal(manifest.distribution.appleNotarization, "not_performed");
  assert.throws(() => createReleaseManifest({ ...input, steps: [{ name: "unit-tests", status: "passed" }] }), /missing/);
  assert.throws(() => createReleaseManifest({ ...input, steps: [...input.steps, { name: "failure", status: "failed" }] }), /every gate/);
  assert.throws(() => createReleaseManifest({ ...input, target: "mac" }), /artifacts/);
});
