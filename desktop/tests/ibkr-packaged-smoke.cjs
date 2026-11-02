// Run with Electron's own Node runtime after packaging, not from the source
// tree: this catches dependencies accidentally supplied by devDependencies.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  const root = process.argv[2];
  assert.ok(root?.endsWith(".app"), "provide a built .app path");
  const entry = path.join(root, "Contents/Resources/app.asar/src/brokers/ibkr-client.mjs");
  const { IbkrClient } = await import(pathToFileURL(entry).href);
  const client = new IbkrClient({ store: { get: async () => undefined } });
  await client.initialize();
  assert.equal(client.config.transport, "tws"); assert.equal(client.config.port, 7496);
  assert.equal(client.status().orderWrite, false);
  process.stdout.write("Packaged IBKR imports and initialization OK (no broker requests).\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });
