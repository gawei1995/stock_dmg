// Electron's Node mode can read app.asar without extracting or launching the
// real application. Only definitions are imported; no credentials or brokers.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
(async () => {
  const appPath = process.argv[2], expectedVersion = process.argv[3];
  assert.ok(appPath?.endsWith(".app") && expectedVersion, "provide built .app and expected version");
  const resources = path.join(appPath, "Contents/Resources"), root = path.join(resources, "app.asar");
  const info = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(info.version, expectedVersion);
  const installedDependencies = {};
  for (const name of Object.keys(info.dependencies)) {
    installedDependencies[name] = JSON.parse(await fs.readFile(path.join(root, "node_modules", name, "package.json"), "utf8")).version;
  }
  async function inventory(directory, entries) {
    const files = [];
    async function walk(relative) {
      const file = path.join(directory, relative), stat = await fs.stat(file);
      if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await walk(path.join(relative, name));
      else {
        const contents = await fs.readFile(file);
        files.push({ path: relative.split(path.sep).join("/"), bytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") });
      }
    }
    for (const entry of entries) await walk(entry);
    return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  }
  const runtime = await inventory(root, ["main.mjs", "preload.cjs", "renderer", "src"]);
  // The host entry is deliberately not imported: that would open user state.
  const modules = runtime.filter((file) => file.path.startsWith("src/") && file.path.endsWith(".mjs"));
  for (const module of modules) await import(pathToFileURL(path.join(root, module.path)).href);
  const { IbkrClient } = await import(pathToFileURL(path.join(root, "src/brokers/ibkr-client.mjs")).href);
  const client = new IbkrClient({ store: { get: async () => undefined } });
  await client.initialize(); assert.equal(client.status().orderWrite, false);
  const skills = await inventory(path.join(resources, "trading-agent-skills"), ["review-decision-cycles", "review-earnings-decisions"]);
  for (const skill of ["review-decision-cycles", "review-earnings-decisions"]) assert.ok(skills.some((file) => file.path === `${skill}/SKILL.md`));
  process.stdout.write(JSON.stringify({ appVersion: info.version, electronVersion: process.versions.electron, dependencies: info.dependencies, installedDependencies,
    importedModuleCount: modules.length, runtime, skills }) + "\n");
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
