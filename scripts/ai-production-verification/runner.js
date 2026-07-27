import { classifyAiVerification, summarizeVerification } from "./classifier.js";

export async function verifyAiProduction({
  baseUrl,
  token,
  workspaceId,
  strict = false,
  fetchImpl = globalThis.fetch,
}) {
  requireConfig("SQUADPITCH_VERIFY_BASE_URL", baseUrl);
  requireConfig("SQUADPITCH_VERIFY_TOKEN", token);
  requireConfig("SQUADPITCH_VERIFY_WORKSPACE_ID", workspaceId);

  const response = await fetchImpl(
    `${baseUrl.replace(/\/$/, "")}/api/v1/internal/ai/production-verification`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Production verification endpoint returned HTTP ${response.status}`,
    );
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.results)) {
    throw new Error("Production verification response was invalid");
  }
  const results = payload.results.map(classifyAiVerification);
  return {
    ...summarizeVerification(results, { strict }),
    environment: payload.environment ?? "production",
    generatedAt: payload.generatedAt ?? new Date().toISOString(),
    skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
  };
}

function requireConfig(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
