// Outbound webhook delivery provider.
// Signs payloads with HMAC-SHA256 and POSTs to the target URL.

import crypto from "node:crypto";

/**
 * Build a versioned webhook payload.
 */
function buildPayload(eventType, payload, userId) {
  return {
    version: "1.0",
    eventType,
    timestamp: new Date().toISOString(),
    userId,
    resourceType: payload.resourceType ?? null,
    resourceId: payload.resourceId ?? null,
    data: payload,
  };
}

/**
 * Compute HMAC-SHA256 signature for the payload.
 */
function sign(body, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
}

/**
 * Deliver a webhook.
 * @param {{ targetUrl: string, secret: string, eventType: string, payload: object, userId: string }} params
 * @returns {{ responseStatus: number, responseBody: string }}
 */
export async function deliverWebhook({ targetUrl, secret, eventType, payload, userId }) {
  const webhookPayload = buildPayload(eventType, payload, userId);
  const body = JSON.stringify(webhookPayload);
  const signature = sign(body, secret);

  const res = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Squadpitch-Signature": signature,
      "X-Squadpitch-Event": eventType,
    },
    body,
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  const responseBody = await res.text().catch(() => "");

  return {
    responseStatus: res.status,
    responseBody: responseBody.slice(0, 2000), // Truncate
  };
}
