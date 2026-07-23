import { env } from "../../config/env.js";
import {
  AI_SERVICE_ERROR_CODES,
  assertPayloadWorkspaceMatchesEnvelope,
  createAiServiceEnvelope,
} from "./serviceEnvelope.js";

export const AI_PLATFORM_ERROR_CODES = Object.freeze({
  DISABLED: "AI_PLATFORM_DISABLED",
  NOT_STAGING: "AI_PLATFORM_NOT_STAGING",
  NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  AUTH_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  TIMEOUT: "PROVIDER_TIMEOUT",
  UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  INVALID_JSON: "PROVIDER_INVALID_JSON",
  SCHEMA_INVALID: "SCHEMA_INVALID",
});

function normalizeBaseUrl(baseUrl) {
  return typeof baseUrl === "string" ? baseUrl.replace(/\/+$/, "") : "";
}

function isTimeoutError(err) {
  return err?.name === "TimeoutError" || err?.name === "AbortError";
}

export async function checkPythonAiPlatformHealth({
  enabled = false,
  environment = env.NODE_ENV,
  baseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  serviceAuthKeyId = env.AI_PLATFORM_SERVICE_AUTH_KEY_ID,
  serviceAuthSecret = env.AI_PLATFORM_SERVICE_AUTH_SECRET,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!enabled) {
    return {
      ok: false,
      enabled: false,
      status: "disabled",
      errorCode: AI_PLATFORM_ERROR_CODES.DISABLED,
    };
  }

  if (environment !== "staging") {
    return {
      ok: false,
      enabled: true,
      status: "blocked",
      errorCode: AI_PLATFORM_ERROR_CODES.NOT_STAGING,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      enabled: true,
      status: "not_configured",
      errorCode: AI_PLATFORM_ERROR_CODES.NOT_CONFIGURED,
    };
  }

  if (!serviceAuthSecret) {
    return {
      ok: false,
      enabled: true,
      status: "not_configured",
      errorCode: AI_PLATFORM_ERROR_CODES.AUTH_NOT_CONFIGURED,
    };
  }

  let envelope;
  try {
    envelope = createAiServiceEnvelope({
      workspaceId: "system",
      actorUserId: "squadpitch-api",
      scopes: ["health:read"],
      payload: { workspaceId: "system", probe: "health" },
      requestId: "node-ai-platform-health",
      traceId: "node-ai-platform-health",
      keyId: serviceAuthKeyId,
      secret: serviceAuthSecret,
    });
    assertPayloadWorkspaceMatchesEnvelope(envelope);
  } catch (err) {
    return {
      ok: false,
      enabled: true,
      status: "invalid_request",
      errorCode: err?.code ?? AI_SERVICE_ERROR_CODES.SCHEMA_INVALID,
    };
  }

  try {
    const res = await fetchImpl(`${normalizedBaseUrl}/v1/health/check`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-request-id": envelope.requestId,
        "x-trace-id": envelope.traceId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        enabled: true,
        status: "invalid_response",
        statusCode: res.status,
        errorCode: AI_PLATFORM_ERROR_CODES.INVALID_JSON,
      };
    }

    if (!res.ok || body?.status !== "ok") {
      return {
        ok: false,
        enabled: true,
        status: "unavailable",
        statusCode: res.status,
        errorCode: body?.code ?? AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
        requestId: body?.requestId ?? envelope.requestId,
        traceId: body?.traceId ?? envelope.traceId,
      };
    }

    return {
      ok: true,
      enabled: true,
      status: "ok",
      statusCode: res.status,
      service: body.service ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      enabled: true,
      status: isTimeoutError(err) ? "timeout" : "unavailable",
      errorCode: isTimeoutError(err)
        ? AI_PLATFORM_ERROR_CODES.TIMEOUT
        : AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
    };
  }
}

export async function callPythonCampaignOpsPlan({
  enabled = false,
  baseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  envelope,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!enabled) {
    return {
      ok: false,
      status: "disabled",
      errorCode: AI_PLATFORM_ERROR_CODES.DISABLED,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      status: "not_configured",
      errorCode: AI_PLATFORM_ERROR_CODES.NOT_CONFIGURED,
    };
  }
  if (!envelope) {
    return {
      ok: false,
      status: "invalid_request",
      errorCode: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
    };
  }

  try {
    const res = await fetchImpl(`${normalizedBaseUrl}/v1/campaign-ops/plan`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-request-id": envelope.requestId,
        "x-trace-id": envelope.traceId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        status: "invalid_response",
        statusCode: res.status,
        errorCode: AI_PLATFORM_ERROR_CODES.INVALID_JSON,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: "unavailable",
        statusCode: res.status,
        errorCode: body?.code ?? AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
        requestId: body?.requestId ?? envelope.requestId,
        traceId: body?.traceId ?? envelope.traceId,
      };
    }

    return {
      ok: true,
      status: "ok",
      statusCode: res.status,
      body,
    };
  } catch (err) {
    return {
      ok: false,
      status: isTimeoutError(err) ? "timeout" : "unavailable",
      errorCode: isTimeoutError(err)
        ? AI_PLATFORM_ERROR_CODES.TIMEOUT
        : AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
    };
  }
}

export async function callPythonDraftContentProposal({
  enabled = false,
  baseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  envelope,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!enabled) {
    return {
      ok: false,
      status: "disabled",
      errorCode: AI_PLATFORM_ERROR_CODES.DISABLED,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      status: "not_configured",
      errorCode: AI_PLATFORM_ERROR_CODES.NOT_CONFIGURED,
    };
  }
  if (!envelope) {
    return {
      ok: false,
      status: "invalid_request",
      errorCode: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
    };
  }

  try {
    const res = await fetchImpl(
      `${normalizedBaseUrl}/v1/campaign-ops/draft-proposal`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-request-id": envelope.requestId,
          "x-trace-id": envelope.traceId,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        status: "invalid_response",
        statusCode: res.status,
        errorCode: AI_PLATFORM_ERROR_CODES.INVALID_JSON,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: "unavailable",
        statusCode: res.status,
        errorCode: body?.code ?? AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
        requestId: body?.requestId ?? envelope.requestId,
        traceId: body?.traceId ?? envelope.traceId,
      };
    }

    return {
      ok: true,
      status: "ok",
      statusCode: res.status,
      body,
    };
  } catch (err) {
    return {
      ok: false,
      status: isTimeoutError(err) ? "timeout" : "unavailable",
      errorCode: isTimeoutError(err)
        ? AI_PLATFORM_ERROR_CODES.TIMEOUT
        : AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
    };
  }
}

export async function callPythonAutopilotRank({
  enabled = false,
  baseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  envelope,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!enabled) {
    return {
      ok: false,
      status: "disabled",
      errorCode: AI_PLATFORM_ERROR_CODES.DISABLED,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      status: "not_configured",
      errorCode: AI_PLATFORM_ERROR_CODES.NOT_CONFIGURED,
    };
  }
  if (!envelope) {
    return {
      ok: false,
      status: "invalid_request",
      errorCode: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
    };
  }

  try {
    const res = await fetchImpl(`${normalizedBaseUrl}/v1/autopilot/rank`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-request-id": envelope.requestId,
        "x-trace-id": envelope.traceId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        status: "invalid_response",
        statusCode: res.status,
        errorCode: AI_PLATFORM_ERROR_CODES.INVALID_JSON,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: "unavailable",
        statusCode: res.status,
        errorCode: body?.code ?? AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
        requestId: body?.requestId ?? envelope.requestId,
        traceId: body?.traceId ?? envelope.traceId,
      };
    }

    return { ok: true, status: "ok", statusCode: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: isTimeoutError(err) ? "timeout" : "unavailable",
      errorCode: isTimeoutError(err)
        ? AI_PLATFORM_ERROR_CODES.TIMEOUT
        : AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
    };
  }
}

export async function callPythonBrandQualityScore({
  enabled = false,
  baseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  envelope,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!enabled) {
    return {
      ok: false,
      status: "disabled",
      errorCode: AI_PLATFORM_ERROR_CODES.DISABLED,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      status: "not_configured",
      errorCode: AI_PLATFORM_ERROR_CODES.NOT_CONFIGURED,
    };
  }
  if (!envelope) {
    return {
      ok: false,
      status: "invalid_request",
      errorCode: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
    };
  }

  try {
    const res = await fetchImpl(
      `${normalizedBaseUrl}/v1/content-quality/score`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-request-id": envelope.requestId,
          "x-trace-id": envelope.traceId,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        status: "invalid_response",
        statusCode: res.status,
        errorCode: AI_PLATFORM_ERROR_CODES.INVALID_JSON,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: "unavailable",
        statusCode: res.status,
        errorCode: body?.code ?? AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
        requestId: body?.requestId ?? envelope.requestId,
        traceId: body?.traceId ?? envelope.traceId,
      };
    }

    return { ok: true, status: "ok", statusCode: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: isTimeoutError(err) ? "timeout" : "unavailable",
      errorCode: isTimeoutError(err)
        ? AI_PLATFORM_ERROR_CODES.TIMEOUT
        : AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
    };
  }
}

export async function callPythonExperimentAnalysis({
  enabled = false,
  baseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  envelope,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!enabled) {
    return {
      ok: false,
      status: "disabled",
      errorCode: AI_PLATFORM_ERROR_CODES.DISABLED,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      status: "not_configured",
      errorCode: AI_PLATFORM_ERROR_CODES.NOT_CONFIGURED,
    };
  }
  if (!envelope) {
    return {
      ok: false,
      status: "invalid_request",
      errorCode: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
    };
  }

  try {
    const res = await fetchImpl(`${normalizedBaseUrl}/v1/experiments/analyze`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-request-id": envelope.requestId,
        "x-trace-id": envelope.traceId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        status: "invalid_response",
        statusCode: res.status,
        errorCode: AI_PLATFORM_ERROR_CODES.INVALID_JSON,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: "unavailable",
        statusCode: res.status,
        errorCode: body?.code ?? AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
        requestId: body?.requestId ?? envelope.requestId,
        traceId: body?.traceId ?? envelope.traceId,
      };
    }

    return { ok: true, status: "ok", statusCode: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: isTimeoutError(err) ? "timeout" : "unavailable",
      errorCode: isTimeoutError(err)
        ? AI_PLATFORM_ERROR_CODES.TIMEOUT
        : AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
    };
  }
}
