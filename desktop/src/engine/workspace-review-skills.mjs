import { access, cp, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const REQUIRED_REVIEW_SKILLS = Object.freeze([
  "review-decision-cycles",
  "review-earnings-decisions",
]);

/** Seed packaged review Skills into a newly-created trading workspace.
 * Existing user/project copies are never overwritten.
 */
export async function ensureWorkspaceReviewSkills({
  workspaceDirectory,
  bundledSkillsDirectory,
  requiredSkills = REQUIRED_REVIEW_SKILLS,
} = {}) {
  if (!path.isAbsolute(String(workspaceDirectory ?? ""))) {
    throw new Error("交易工作区路径必须是绝对路径。");
  }
  if (!path.isAbsolute(String(bundledSkillsDirectory ?? ""))) {
    return {
      status: "unavailable",
      installed: [],
      retained: [],
      missing: [...requiredSkills],
      reason: "bundled_review_skills_path_unavailable",
    };
  }
  const targetRoot = path.join(workspaceDirectory, ".agents", "skills");
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const installed = [];
  const retained = [];
  const missing = [];
  for (const name of requiredSkills) {
    const safeName = String(name ?? "").trim();
    if (!/^[a-z0-9-]{1,80}$/.test(safeName)) throw new Error("复盘 Skill 名称无效。");
    const target = path.join(targetRoot, safeName);
    if (await exists(path.join(target, "SKILL.md"))) {
      retained.push(safeName);
      continue;
    }
    const source = path.join(bundledSkillsDirectory, safeName);
    if (!await exists(path.join(source, "SKILL.md"))) {
      missing.push(safeName);
      continue;
    }
    try {
      await cp(source, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      installed.push(safeName);
    } catch (error) {
      // Another app instance may have won the copy race. Accept it only when
      // the required entrypoint is now present.
      if (await exists(path.join(target, "SKILL.md"))) retained.push(safeName);
      else throw error;
    }
  }
  const versions = await Promise.all(requiredSkills.map(async (name) => {
    const actual = await fingerprintSkillDirectory(path.join(targetRoot, name));
    const bundled = await fingerprintSkillDirectory(path.join(bundledSkillsDirectory, name));
    const matchesBundle = actual.status === "verified" && bundled.status === "verified"
      && actual.contentHash === bundled.contentHash;
    return {
      name, ...actual, bundledContentHash: bundled.contentHash,
      matchesBundle,
      provenance: matchesBundle ? "bundled" : actual.status === "verified" ? "custom_or_older" : "unverified",
      compatibility: matchesBundle ? "bundled_contract" : "not_verified",
    };
  }));
  const warnings = versions.filter(item => !item.matchesBundle).map(item => ({
    name: item.name,
    reason: item.status !== "verified" ? item.reason : "workspace_differs_from_bundle",
    message: item.status !== "verified" ? `${item.name} 内容版本无法完整核验`
      : `${item.name} 为自定义或旧版本；已保留，未覆盖，请核对与内置版的差异`,
  }));
  return {
    status: missing.length ? "partial" : "ready",
    installed,
    retained,
    missing,
    versions,
    warnings,
    reason: missing.length ? "required_packaged_review_skills_missing" : null,
  };
}

/** A reproducibility fingerprint, never a copy of Skill text in app state.
 * Referenced files outside this directory remain an explicit limitation. */
export async function fingerprintSkillDirectory(directory, { maxFiles = 500, maxBytes = 20 * 1024 * 1024 } = {}) {
  const files = [];
  let bytes = 0;
  const omissions = [];
  try {
    if (!path.isAbsolute(String(directory ?? ""))) throw new Error("skill_path_unavailable");
    const root = await realpath(directory);
    const entrypoint = path.join(root, "SKILL.md");
    await access(entrypoint);
    const walk = async (current, prefix = "") => {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        if ([".git", "node_modules", ".DS_Store", "__pycache__"].includes(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const filePath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) { omissions.push({ path: relative, reason: "symlink_not_followed" }); continue; }
        if (entry.isDirectory()) { await walk(filePath, relative); continue; }
        if (!entry.isFile()) { omissions.push({ path: relative, reason: "unsupported_file_type" }); continue; }
        const stat = await lstat(filePath);
        if (files.length >= maxFiles || bytes + stat.size > maxBytes) throw new Error("skill_fingerprint_budget");
        const content = await readFile(filePath);
        bytes += content.length;
        if (bytes > maxBytes) throw new Error("skill_fingerprint_budget");
        files.push({ path: relative, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length });
      }
    };
    await walk(root);
    const entrypointHash = files.find(item => item.path === "SKILL.md")?.sha256 ?? null;
    if (!entrypointHash) throw new Error("skill_entrypoint_unverified");
    return {
      status: omissions.length ? "partial" : "verified",
      contentHash: omissions.length ? null : createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      entrypointHash,
      files, bytes, omissions,
      reason: omissions.length ? "skill_files_omitted" : null,
      boundary: "local_skill_directory_only_external_dependencies_not_fingerprinted",
    };
  } catch (error) {
    return {
      status: "unavailable", contentHash: null, entrypointHash: null, files: [], bytes: 0, omissions,
      reason: ["skill_path_unavailable", "skill_fingerprint_budget", "skill_entrypoint_unverified"].includes(error.message)
        ? error.message : "skill_files_unavailable",
    };
  }
}

export async function fingerprintRequestedSkills(skills = []) {
  return Promise.all(skills.map(async (skill) => {
    const entrypoint = String(skill.path ?? "");
    const directory = path.basename(entrypoint) === "SKILL.md" ? path.dirname(entrypoint) : entrypoint;
    return { name: skill.name, ...await fingerprintSkillDirectory(directory) };
  }));
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
