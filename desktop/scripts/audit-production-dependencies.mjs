import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRODUCTION_AUDIT_ARGS = Object.freeze(["audit", "--omit=dev", "--ignore-scripts", "--json"]);
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function auditFailure(reason, evidence) {
  const error = new Error(`Production dependency security audit did not pass: ${reason}.`);
  error.code = "PRODUCTION_DEPENDENCY_AUDIT_FAILED";
  error.evidence = { ...evidence, status: "failed", reason };
  return error;
}

/** Accept a real, complete npm v2 audit result, not merely a zero process exit. */
export function assessProductionAudit({ stdout = "", exitCode, signal = null }, { auditedAt, lockSha256 }) {
  let evidence = {
    schemaVersion: 1, status: "failed", scope: "production",
    command: ["npm", ...PRODUCTION_AUDIT_ARGS], auditedAt, lockSha256,
    reportSha256: hash(stdout),
  };
  let report;
  try { report = JSON.parse(stdout); }
  catch { throw auditFailure("invalid_json", evidence); }
  const counts = report?.metadata?.vulnerabilities;
  const dependencies = report?.metadata?.dependencies;
  if (!record(report) || report.error != null || report.auditReportVersion !== 2
    || !record(report.vulnerabilities) || !record(counts) || !record(dependencies)
    || ![...SEVERITIES, "total"].every((name) => count(counts[name]))
    || !count(dependencies.prod) || !count(dependencies.total)
    || !Object.values(dependencies).every(count)
    || counts.total !== SEVERITIES.reduce((sum, name) => sum + counts[name], 0)) {
    throw auditFailure("incomplete_or_error_report", evidence);
  }
  const packages = Object.entries(report.vulnerabilities);
  const actual = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [, vulnerability] of packages) {
    if (!record(vulnerability) || !SEVERITIES.includes(vulnerability.severity)) {
      throw auditFailure("invalid_vulnerability_entry", evidence);
    }
    actual[vulnerability.severity] += 1;
  }
  if (packages.length !== counts.total || !SEVERITIES.every((severity) => actual[severity] === counts[severity])) {
    throw auditFailure("inconsistent_vulnerability_counts", evidence);
  }
  evidence = {
    ...evidence, npmAuditReportVersion: report.auditReportVersion,
    vulnerabilities: Object.fromEntries([...SEVERITIES, "total"].map((name) => [name, counts[name]])),
    dependencies: { ...dependencies },
    affectedPackages: packages.map(([name, value]) => ({ name, severity: value.severity })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  // npm's configured audit-level can allow a zero exit despite lower-severity findings.
  if (counts.total !== 0) throw auditFailure("known_vulnerabilities", evidence);
  if (exitCode !== 0 || signal !== null) throw auditFailure("audit_process_failed", evidence);
  return { ...evidence, status: "passed" };
}

export function assertCleanProductionAudit(evidence, expectedLockSha256) {
  if (!record(evidence) || evidence.schemaVersion !== 1 || evidence.status !== "passed"
    || evidence.scope !== "production" || evidence.npmAuditReportVersion !== 2
    || JSON.stringify(evidence.command) !== JSON.stringify(["npm", ...PRODUCTION_AUDIT_ARGS])
    || !Number.isFinite(Date.parse(evidence.auditedAt))
    || !/^[a-f0-9]{64}$/.test(evidence.reportSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(evidence.lockSha256 ?? "")
    || evidence.lockSha256 !== expectedLockSha256
    || !record(evidence.vulnerabilities)
    || ![...SEVERITIES, "total"].every((name) => evidence.vulnerabilities[name] === 0)
    || !record(evidence.dependencies) || !count(evidence.dependencies.prod) || !count(evidence.dependencies.total)
    || !Object.values(evidence.dependencies).every(count)
    || !Array.isArray(evidence.affectedPackages) || evidence.affectedPackages.length !== 0) {
    throw new Error("A clean production dependency security audit bound to the verified lockfile is required.");
  }
}

function invokeNpmAudit({ cwd }) {
  return new Promise((resolve) => {
    execFile("npm", PRODUCTION_AUDIT_ARGS, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      resolve({ stdout, exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0, signal: error?.signal ?? null });
    });
  });
}

export async function auditProductionDependencies({ desktopRoot, runAudit = invokeNpmAudit, now = () => new Date().toISOString() }) {
  const lockPath = path.join(desktopRoot, "package-lock.json");
  const lockSha256 = hash(await readFile(lockPath));
  const result = await runAudit({ cwd: desktopRoot });
  const evidence = assessProductionAudit(result, { auditedAt: now(), lockSha256 });
  if (hash(await readFile(lockPath)) !== lockSha256) throw auditFailure("dependency_lock_changed_during_audit", evidence);
  assertCleanProductionAudit(evidence, lockSha256);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const evidence = await auditProductionDependencies({ desktopRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    if (error.evidence) process.stdout.write(`${JSON.stringify(error.evidence, null, 2)}\n`);
    // Avoid echoing npm diagnostics, which may contain registry or local account details.
    process.stderr.write("Production dependency security audit FAILED; no passing evidence issued.\n");
    process.exitCode = 1;
  }
}
