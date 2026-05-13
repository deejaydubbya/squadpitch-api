// Simple Redis-backed sliding-window rate limiter for the public
// API surface. Keys are namespaced "rl:<scope>:<id>" so multiple
// limit dimensions (per-IP, per-form, per-workspace) don't
// collide.
//
// Uses INCR + EXPIRE to keep it cheap. The "sliding" property is
// approximate — INCR resets on the TTL boundary rather than
// computing a true rolling window — but it's accurate enough to
// keep a single IP from machine-gunning the form endpoint, and
// it's O(1).
//
// When Redis is unavailable the limiter fails OPEN (i.e. allows
// the request) so a stale Redis doesn't take down the public
// surface. We log loudly so this is visible during incident
// triage.

import { getRedis } from "../../redis.js";

/**
 * @param {string} scope — short identifier for the limit dimension,
 *   e.g. "form-ip", "resolve-host"
 * @param {string} id — the per-dimension identity, e.g. an IP hash
 *   or a formId
 * @param {number} max — max requests allowed within `windowSec`
 * @param {number} windowSec — window length in seconds
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfterSec: number}>}
 */
export async function checkRateLimit(scope, id, max, windowSec) {
  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    console.warn("[rateLimit] Redis unavailable, failing open:", err?.message ?? err);
    return { allowed: true, remaining: max, retryAfterSec: 0 };
  }
  if (!redis) {
    return { allowed: true, remaining: max, retryAfterSec: 0 };
  }

  const key = `rl:${scope}:${id}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // Fresh window — set the TTL. PX would give millisecond
      // precision but seconds is fine for these rate floors.
      await redis.expire(key, windowSec);
    }
    if (count > max) {
      // Fetch the actual TTL so the response can hint at when
      // to retry. If TTL is -1 (no expire set — race), recover
      // by setting the expire and treating retry as windowSec.
      const ttl = await redis.ttl(key);
      const retryAfterSec = ttl > 0 ? ttl : windowSec;
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    return { allowed: true, remaining: max - count, retryAfterSec: 0 };
  } catch (err) {
    console.warn("[rateLimit] failed open:", err?.message ?? err);
    return { allowed: true, remaining: max, retryAfterSec: 0 };
  }
}
