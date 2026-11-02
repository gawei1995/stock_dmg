import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const TWS_NAME = /^Trader Workstation(?: (\d{1,3}(?:\.\d{1,4}){1,3}))?(\.app)?$/;

// Standard macOS install locations only. Never accept a launch path from the
// renderer, traverse user data, or mistake an uninstaller/cache for TWS.
export async function findTwsApplication({ homeDirectory, systemApplicationsDirectory = "/Applications" }) {
  if (!path.isAbsolute(homeDirectory) || !path.isAbsolute(systemApplicationsDirectory)) {
    throw new Error("TWS 应用目录必须为绝对路径。");
  }
  const roots = [path.join(homeDirectory, "Applications"), systemApplicationsDirectory];
  const candidates = [];
  for (const [priority, root] of roots.entries()) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) continue;
      throw error;
    }
    for (const entry of entries) {
      const match = entry.name.match(TWS_NAME);
      if (!match || !entry.isDirectory()) continue;
      const application = match[2]
        ? path.join(root, entry.name)
        : path.join(root, entry.name, `${entry.name}.app`);
      try {
        const [bundle, info, executableDirectory] = await Promise.all([
          lstat(application), lstat(path.join(application, "Contents/Info.plist")),
          lstat(path.join(application, "Contents/MacOS")),
        ]);
        if (!bundle.isDirectory() || !info.isFile() || !executableDirectory.isDirectory()) continue;
        candidates.push({ path: application, version: match[1] ?? null, priority });
      } catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) continue;
        throw error;
      }
    }
  }
  candidates.sort((left, right) => {
    // Number components, not lexical order: 10.50 comes after 10.9. A generic
    // auto-updating installation has no verifiable version in its path, so it
    // is the fallback rather than overriding an explicitly versioned install.
    const a = left.version?.split(".").map(Number) ?? [];
    const b = right.version?.split(".").map(Number) ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const difference = (b[i] ?? 0) - (a[i] ?? 0);
      if (difference) return difference;
    }
    return left.priority - right.priority || left.path.localeCompare(right.path, "en");
  });
  const selected = candidates[0];
  return selected ? { path: selected.path, version: selected.version } : null;
}
