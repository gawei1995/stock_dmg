import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureWorkspaceReviewSkills, fingerprintRequestedSkills, fingerprintSkillDirectory } from "../src/engine/workspace-review-skills.mjs";

test("packaged review skills seed a fresh workspace without overwriting user copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cockpit-skills-"));
  const bundle = path.join(root, "bundle");
  const workspace = path.join(root, "workspace");
  for (const name of ["review-decision-cycles", "review-earnings-decisions"]) {
    await mkdir(path.join(bundle, name), { recursive: true });
    await writeFile(path.join(bundle, name, "SKILL.md"), `bundled:${name}`);
  }
  const first = await ensureWorkspaceReviewSkills({ workspaceDirectory: workspace, bundledSkillsDirectory: bundle });
  assert.equal(first.status, "ready");
  assert.equal(first.installed.length, 2);
  assert.ok(first.versions.every(item => item.matchesBundle && item.contentHash));
  assert.deepEqual(first.warnings, []);

  const userSkill = path.join(workspace, ".agents", "skills", "review-decision-cycles", "SKILL.md");
  await writeFile(userSkill, "user customized");
  const second = await ensureWorkspaceReviewSkills({ workspaceDirectory: workspace, bundledSkillsDirectory: bundle });
  assert.equal(second.status, "ready");
  assert.equal(await readFile(userSkill, "utf8"), "user customized");
  assert.deepEqual(second.retained.sort(), ["review-decision-cycles", "review-earnings-decisions"]);
  assert.equal(second.versions.find(item => item.name === "review-decision-cycles").compatibility, "not_verified");
  assert.equal(second.warnings[0].reason, "workspace_differs_from_bundle");
});

test("skill fingerprints include referenced local resources without persisting their content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cockpit-skill-hash-"));
  await mkdir(path.join(root, "references"));
  await writeFile(path.join(root, "SKILL.md"), "See references/protocol.md");
  await writeFile(path.join(root, "references", "protocol.md"), "protocol-v1 private note");
  const first = await fingerprintSkillDirectory(root);
  assert.equal(first.status, "verified");
  assert.equal(first.files.length, 2);
  assert.doesNotMatch(JSON.stringify(first), /private note/);
  const second = (await fingerprintRequestedSkills([{ name: "review", path: path.join(root, "SKILL.md") }]))[0];
  assert.equal(first.contentHash, second.contentHash);
  await writeFile(path.join(root, "references", "protocol.md"), "protocol-v2 private note");
  const third = await fingerprintSkillDirectory(root);
  assert.notEqual(third.contentHash, first.contentHash);
  assert.equal(third.entrypointHash, first.entrypointHash);
});

test("skill fingerprint omissions and limits never claim fully verified content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cockpit-skill-hash-"));
  await writeFile(path.join(root, "SKILL.md"), "skill text");
  const limited = await fingerprintSkillDirectory(root, { maxBytes: 1 });
  assert.equal(limited.status, "unavailable");
  assert.equal(limited.contentHash, null);
  await symlink(path.join(root, "SKILL.md"), path.join(root, "external-reference.md"));
  const linked = await fingerprintSkillDirectory(root);
  assert.equal(linked.status, "partial");
  assert.equal(linked.contentHash, null);
  assert.equal(linked.omissions[0].reason, "symlink_not_followed");
});

test("missing packaged skill is reported instead of silently pretending review is ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cockpit-skills-missing-"));
  const bundle = path.join(root, "bundle");
  const workspace = path.join(root, "workspace");
  await mkdir(bundle, { recursive: true });
  const result = await ensureWorkspaceReviewSkills({ workspaceDirectory: workspace, bundledSkillsDirectory: bundle });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.missing.sort(), ["review-decision-cycles", "review-earnings-decisions"]);
});
