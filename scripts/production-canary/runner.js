export async function verifyProductionCanary({
  baseUrl,
  workspaceId,
  token,
  cookie,
  runId,
  fetchImpl = globalThis.fetch,
}) {
  requireValue("SQUADPITCH_CANARY_BASE_URL", baseUrl);
  requireValue("SQUADPITCH_CANARY_WORKSPACE_ID", workspaceId);
  requireValue("SQUADPITCH_CANARY_RUN_ID", runId);
  if (!token && !cookie) {
    throw new Error(
      "Missing authentication: set SQUADPITCH_CANARY_TOKEN or SQUADPITCH_CANARY_COOKIE",
    );
  }
  const proxy = Boolean(cookie);
  const root = baseUrl.replace(/\/$/, "");
  const path = proxy
    ? `/api/proxy/workspaces/${encodeURIComponent(workspaceId)}/production-canary`
    : `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/production-canary`;
  const headers = {
    "content-type": "application/json",
    "x-request-id": `production-canary:${runId}`,
  };
  if (cookie) headers.cookie = cookie;
  else headers.authorization = `Bearer ${token}`;

  const response = await fetchImpl(`${root}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ synthetic: true, runId }),
  });
  const payload = await response.json().catch(() => null);
  if (!payload?.summary || !Array.isArray(payload?.results)) {
    throw new Error(`Production canary returned invalid HTTP ${response.status} response`);
  }
  return { ...payload, httpStatus: response.status };
}

function requireValue(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
