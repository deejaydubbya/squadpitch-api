export function renderReadinessReport(report) {
  const lines = ["Squadpitch Production Readiness", ""];
  let currentGroup = null;
  for (const item of report.checks) {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      lines.push(currentGroup);
    }
    lines.push(
      `  ${item.status.padEnd(7)} ${item.id} [${item.kind}] — ${item.message}`,
    );
    if (item.status !== "PASS") {
      lines.push(`          Remediation: ${item.remediation}`);
    }
  }
  lines.push(
    "",
    `PASS ${report.summary.pass} | WARN ${report.summary.warn} | BLOCKED ${report.summary.blocked} | FAIL ${report.summary.fail}`,
    `Overall: ${report.summary.status}`,
  );
  return lines.join("\n");
}
