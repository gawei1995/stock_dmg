// Offline dataset preparation and manual checklist arithmetic only.
// No model client, tool runner, account access, or natural-language auto-grader.
import { createHash } from "node:crypto";

export function prepareCase(suite, caseId) {
  const item = suite.cases.find(row => row.id === caseId);
  if (!item) throw new Error("Unknown evaluation case");
  const payload = structuredClone({ caseId, instructions: suite.delivery.instructions, input: item.input });
  const inputHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { payload, inputHash };
}

export function summarizeManualChecks(suite, assessments = {}) {
  const knownCases = new Set(suite.cases.map(row => row.id));
  if (Object.keys(assessments).some(id => !knownCases.has(id))) throw new Error("Unknown case assessment");
  const cases = suite.cases.map(item => {
    const values = assessments[item.id] ?? {};
    const knownChecks = new Set(item.checks.map(check => check.id));
    if (Object.keys(values).some(id => !knownChecks.has(id))) throw new Error("Unknown rubric check");
    let passed = 0, failed = 0, notAssessed = 0, criticalFailed = 0;
    for (const check of item.checks) {
      const value = values[check.id];
      if (value === true) passed++;
      else if (value === false) { failed++; if (check.critical) criticalFailed++; }
      else if (value == null) notAssessed++;
      else throw new Error("Assessment must be true, false, or null");
    }
    return { caseId: item.id, passed, failed, notAssessed, criticalFailed,
      rubricPassed: notAssessed === 0 && failed === 0 };
  });
  const totals = cases.reduce((sum, row) => {
    for (const key of ["passed", "failed", "notAssessed", "criticalFailed"]) sum[key] += row[key];
    return sum;
  }, { passed: 0, failed: 0, notAssessed: 0, criticalFailed: 0 });
  const denominator = totals.passed + totals.failed + totals.notAssessed;
  return { kind: "manual_checklist_summary", answersVerifiedByScript: false,
    ...totals, denominator, passedFraction: denominator ? totals.passed / denominator : null,
    rubricPassed: cases.length > 0 && cases.every(row => row.rubricPassed), cases };
}
