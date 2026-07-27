import { classifyAiVerification, summarizeVerification } from "./classifier.js";

export async function verifyAiProduction({
  baseUrl,
  token,
  cookie,
  workspaceId,
  strict = false,
  fetchImpl = globalThis.fetch,
}) {
  requireConfig("SQUADPITCH_VERIFY_BASE_URL", baseUrl);
  if (!token && !cookie) {
    throw new Error(
      "Missing authentication: set SQUADPITCH_VERIFY_TOKEN or SQUADPITCH_VERIFY_COOKIE",
    );
  }
  requireConfig("SQUADPITCH_VERIFY_WORKSPACE_ID", workspaceId);

  const usingCookie = typeof cookie === "string" && cookie.trim() !== "";
  const endpoint = usingCookie
    ? `${baseUrl.replace(/\/$/, "")}/api/proxy/internal/ai/production-verification`
    : `${baseUrl.replace(/\/$/, "")}/api/v1/internal/ai/production-verification`;
  const headers = { "content-type": "application/json" };
  if (usingCookie) headers.cookie = cookie;
  else headers.authorization = `Bearer ${token}`;

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspaceId }),
  });
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
