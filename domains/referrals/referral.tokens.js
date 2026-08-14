import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const secret = () => process.env.OAUTH_STATE_SECRET || process.env.TOKEN_ENCRYPTION_KEY;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signature(payload) {
  if (!secret()) throw Object.assign(new Error("Referral capture is unavailable"), { status: 503, code: "REFERRAL_CAPTURE_UNAVAILABLE" });
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueReferralCapture(codeId, now = new Date()) {
  const payload = encode({ codeId, capturedAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS).toISOString() });
  return `${payload}.${signature(payload)}`;
}

export function verifyReferralCapture(token, now = new Date()) {
  if (typeof token !== "string" || token.length > 1000) return null;
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra) return null;
  const expected = signature(payload);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const capturedAt = new Date(parsed.capturedAt);
    const expiresAt = new Date(parsed.expiresAt);
    if (!parsed.codeId || !Number.isFinite(capturedAt.getTime()) || expiresAt <= now || capturedAt > now) return null;
    return { codeId: parsed.codeId, capturedAt, expiresAt };
  } catch { return null; }
}

export const REFERRAL_CAPTURE_MAX_AGE_SECONDS = TTL_MS / 1000;
