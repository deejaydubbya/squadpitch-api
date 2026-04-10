// HMAC-signed OAuth state blobs for OAuth flows.
//
// Token format:
//   base64url(json({ clientId, channel, nonce, exp })) + "." + base64url(hmac)
//
// The nonce is a single-use value stored in Redis (10m TTL) so that a
// replayed state token (e.g. from a stolen URL) is rejected after the
// first verify. `exp` is a fallback when Redis is unavailable so the
// token still can't live forever.

import crypto from "node:crypto";
import { env } from "../../../config/env.js";
import { redisGet, redisSet, redisDel } from "../../../redis.js";

const STATE_TTL_SECONDS = 10 * 60; // 10 minutes
const NONCE_KEY_PREFIX = "sp:oauth:nonce:";

function getSecret() {
  if (!env.OAUTH_STATE_SECRET) {
    throw Object.assign(new Error("OAuth state secret not configured"), {
      status: 500,
      code: "OAUTH_STATE_NOT_CONFIGURED",
    });
  }
  return env.OAUTH_STATE_SECRET;
}

// Node 16+ supports "base64url" directly on Buffer.toString/Buffer.from —
// use the native encoding rather than re-implementing character swaps.
function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function base64urlDecode(str) {
  return Buffer.from(str, "base64url");
}

function hmac(payload) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest();
}

/**
 * Sign a state payload. The returned token is safe to embed in a URL.
 * Also stores the nonce in Redis with a TTL so replay can be rejected.
 */
export async function signState({ clientId, channel }) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const exp = Date.now() + STATE_TTL_SECONDS * 1000;
  const payload = JSON.stringify({ clientId, channel, nonce, exp });
  const payloadB64 = base64url(payload);
  const sig = base64url(hmac(payloadB64));

  // Best-effort nonce store. If Redis is down we still have exp as fallback.
  await redisSet(
    `${NONCE_KEY_PREFIX}${nonce}`,
    JSON.stringify({ clientId, channel }),
    STATE_TTL_SECONDS
  );

  return {
    token: `${payloadB64}.${sig}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

function invalidState(message, cause) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "INVALID_OAUTH_STATE",
    cause,
  });
}

/**
 * Verify a state token. Returns the decoded payload on success.
 * Single-use: the nonce is deleted from Redis after successful verification.
 */
export async function verifyState(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    throw invalidState("Missing or malformed state token");
  }
  const [payloadB64, sig] = token.split(".");
  const expectedSig = base64url(hmac(payloadB64));
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw invalidState("State signature mismatch");
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch (err) {
    throw invalidState("Unable to decode state payload", err);
  }

  const { clientId, channel, nonce, exp } = payload;
  if (!clientId || !channel || !nonce || !exp) {
    throw invalidState("State payload missing fields");
  }
  if (typeof exp !== "number" || Date.now() > exp) {
    throw invalidState("State token expired");
  }

  // Single-use nonce check (best effort — if Redis is down, exp alone gates).
  const nonceKey = `${NONCE_KEY_PREFIX}${nonce}`;
  const stored = await redisGet(nonceKey);
  if (stored === null) {
    // Redis down OR nonce already consumed. We can't distinguish —
    // prefer safety and reject. Fresh flow just regenerates.
    throw invalidState("State nonce already consumed or expired");
  }
  await redisDel(nonceKey);

  return { clientId, channel, nonce, exp };
}
