function label(status) {
  return status.replaceAll("_", "-");
}

export function renderConsoleReport(
  report,
  { apiUrl, startedAt, skipped = [] } = {},
) {
  const lines = [
    "=".repeat(60),
    "Squadpitch AI Production Verification",
    "=".repeat(60),
    "",
    `API: ${apiUrl}`,
    `Started: ${startedAt}`,
    "",
  ];
  for (const result of report.results) {
    lines.push(`[${label(result.status)}] ${result.name}`);
    lines.push(`  Source: ${result.source ?? "unavailable"}`);
    lines.push(`  Implementation: ${result.implementation ?? "unavailable"}`);
    lines.push(`  Fallback: ${result.fallbackUsed ? "yes" : "no"}`);
    if (result.fallbackLayer)
      lines.push(`  Fallback layer: ${result.fallbackLayer}`);
    if (result.fallbackReason) lines.push(`  Reason: ${result.fallbackReason}`);
    if (result.serviceVersion)
      lines.push(`  Service version: ${result.serviceVersion}`);
    if (result.model) lines.push(`  Model: ${result.model}`);
    if (result.modelVersion)
      lines.push(`  Model version: ${result.modelVersion}`);
    if (result.latencyMs != null)
      lines.push(`  Latency: ${result.latencyMs} ms`);
    if (result.traceId) lines.push(`  Trace: ${result.traceId}`);
    if (result.message) lines.push(`  Message: ${result.message}`);
    lines.push("");
  }
  for (const item of skipped) {
    lines.push(`[SKIPPED] ${item.name}`);
    lines.push(`  Reason: ${item.reason}`);
    lines.push("");
  }
  lines.push("-".repeat(60));
  lines.push(`Hosted: ${report.pass}`);
  lines.push(`Python fallback: ${report.warnPython}`);
  lines.push(`Node fallback/local: ${report.warnNode}`);
  lines.push(`Failed: ${report.fail}`);
  lines.push(`Skipped: ${skipped.length}`);
  lines.push("-".repeat(60));
  lines.push("");
  lines.push(`Overall: ${report.status.replaceAll("_", " ")}`);
  lines.push(`Exit code: ${report.exitCode}`);
  return lines.join("\n");
}
