const HEADER_MAP = Object.freeze({
  source: "x-squadpitch-ai-source",
  operation: "x-squadpitch-ai-operation",
  fallbackUsed: "x-squadpitch-ai-fallback",
  fallbackLayer: "x-squadpitch-ai-fallback-layer",
  fallbackReason: "x-squadpitch-ai-fallback-reason",
  implementation: "x-squadpitch-ai-implementation",
  serviceVersion: "x-squadpitch-ai-service-version",
  model: "x-squadpitch-ai-model",
  modelVersion: "x-squadpitch-ai-model-version",
  traceId: "x-squadpitch-ai-trace-id",
});

export function parseAiProvenanceHeaders(headers) {
  const provenance = {};
  for (const [field, header] of Object.entries(HEADER_MAP)) {
    const value = headers?.get?.(header);
    if (value == null || value === "") continue;
    provenance[field] =
      field === "fallbackUsed" ? value.toLowerCase() === "true" : value;
  }
  return provenance;
}
