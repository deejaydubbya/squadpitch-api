export async function verifyProductionCanary({
  baseUrl,
  workspaceId,
  token,
  runId,
  fetchImpl = globalThis.fetch,
}) {
  requireValue("SQUADPITCH_CANARY_BASE_URL", baseUrl);
  requireValue("SQUADPITCH_CANARY_WORKSPACE_ID", workspaceId);
  requireValue("SQUADPITCH_CANARY_RUN_ID", runId);
  if (!token) throw new Error("Missing supported canary access token");
  const root = baseUrl.replace(/\/$/, "");
  const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/production-canary`;
  const headers = {
    "content-type": "application/json",
    "x-request-id": `production-canary:${runId}`,
  };
  headers.authorization = `Bearer ${token}`;

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

export async function exchangeCanaryRefreshToken({
  auth0Domain,
  clientId,
  refreshToken,
  audience,
  fetchImpl = globalThis.fetch,
}) {
  for (const [name, value] of Object.entries({ auth0Domain, clientId, refreshToken, audience })) {
    requireValue(name, value);
  }
  const domain = auth0Domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const response = await fetchImpl(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      audience,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(`Canary token exchange failed (${response.status})`);
  }
  return payload.access_token;
}

function requireValue(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
