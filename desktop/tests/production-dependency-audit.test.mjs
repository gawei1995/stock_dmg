import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assessProductionAudit, assertCleanProductionAudit, auditProductionDependencies, PRODUCTION_AUDIT_ARGS } from "../scripts/audit-production-dependencies.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const stamp = "2026-11-03T00:00:00.000Z";
const context = { auditedAt: stamp, lockSha256: hash("fixture-lock") };
const cleanReport = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: {
  vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  dependencies: { prod: 101, dev: 255, optional: 23, peer: 14, peerOptional: 0, total: 356 },
} });
const result = (report = cleanReport(), extra = {}) => ({ stdout: JSON.stringify(report), exitCode: 0, ...extra });

test("production audit binds a complete zero finding report to its lock and retains time, counts and raw report hash", () => {
  const execution = result(), evidence = assessProductionAudit(execution, context);
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.auditedAt, stamp);
  assert.equal(evidence.lockSha256, context.lockSha256);
  assert.equal(evidence.reportSha256, hash(execution.stdout));
  assert.deepEqual(evidence.vulnerabilities, cleanReport().metadata.vulnerabilities);
  assert.deepEqual(evidence.dependencies, cleanReport().metadata.dependencies);
  assert.deepEqual(evidence.command, ["npm", "audit", "--omit=dev", "--ignore-scripts", "--json"]);
  assert.deepEqual(PRODUCTION_AUDIT_ARGS, evidence.command.slice(1));
  assert.doesNotThrow(() => assertCleanProductionAudit(evidence, context.lockSha256));
});

test("every severity blocks release even when npm audit-level makes the process return zero", () => {
  for (const severity of ["info", "low", "moderate", "high", "critical"]) {
    const report = cleanReport();
    report.vulnerabilities.example = { severity };
    report.metadata.vulnerabilities[severity] = 1;
    report.metadata.vulnerabilities.total = 1;
    for (const exitCode of [0, 1]) assert.throws(() => assessProductionAudit(result(report, { exitCode }), context), (error) => {
      assert.equal(error.code, "PRODUCTION_DEPENDENCY_AUDIT_FAILED");
      assert.equal(error.evidence.reason, "known_vulnerabilities");
      assert.equal(error.evidence.vulnerabilities.total, 1);
      assert.deepEqual(error.evidence.affectedPackages, [{ name: "example", severity }]);
      return true;
    });
  }
});

test("network failures, truncated JSON, unsupported reports and incomplete or inconsistent counts fail closed", () => {
  const bad = [
    "", "{", "null", "[]", JSON.stringify({ error: { code: "ENOTFOUND", summary: "registry unavailable" } }),
    JSON.stringify({ ...cleanReport(), auditReportVersion: 1 }),
    JSON.stringify({ ...cleanReport(), error: {} }),
  ];
  const omitted = cleanReport(); delete omitted.metadata.vulnerabilities.low; bad.push(JSON.stringify(omitted));
  const negative = cleanReport(); negative.metadata.vulnerabilities.total = -1; bad.push(JSON.stringify(negative));
  const total = cleanReport(); total.metadata.vulnerabilities.high = 1; bad.push(JSON.stringify(total));
  const hidden = cleanReport(); hidden.vulnerabilities.example = { severity: "high" }; bad.push(JSON.stringify(hidden));
  const unknown = cleanReport(); unknown.vulnerabilities.example = { severity: "unknown" }; bad.push(JSON.stringify(unknown));
  const dependencies = cleanReport(); delete dependencies.metadata.dependencies.prod; bad.push(JSON.stringify(dependencies));
  for (const stdout of bad) assert.throws(() => assessProductionAudit({ stdout, exitCode: 0 }, context), { code: "PRODUCTION_DEPENDENCY_AUDIT_FAILED" });
  for (const extra of [{ exitCode: 1 }, { exitCode: null }, { signal: "SIGTERM" }]) {
    assert.throws(() => assessProductionAudit(result(cleanReport(), extra), context), /audit_process_failed/);
  }
});

test("standalone audit is read only and detects a dependency lock mutation during the registry request", async (t) => {
  const desktopRoot = await mkdtemp(path.join(tmpdir(), "cockpit-audit-test-"));
  t.after(() => rm(desktopRoot, { recursive: true, force: true }));
  const lock = path.join(desktopRoot, "package-lock.json");
  await writeFile(lock, "fixture-lock");
  const evidence = await auditProductionDependencies({ desktopRoot, now: () => stamp, runAudit: async ({ cwd }) => {
    assert.equal(cwd, desktopRoot); return result();
  } });
  assert.equal(evidence.lockSha256, hash("fixture-lock"));
  await assert.rejects(auditProductionDependencies({ desktopRoot, now: () => stamp, runAudit: async () => {
    await writeFile(lock, "changed-lock"); return result();
  } }), /dependency_lock_changed_during_audit/);
});
