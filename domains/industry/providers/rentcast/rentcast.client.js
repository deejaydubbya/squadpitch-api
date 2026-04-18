// Shared RentCast HTTP client.
//
// Handles auth, timeout, token-bucket rate limiting, retry with backoff,
// and request logging for all RentCast API endpoints.

import { env } from "../../../../config/env.js";

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 1;
const RETRY_DELAYS = [2000, 4000];

// Simple token-bucket rate limiter (20 req/s, in-memory)
const bucket = { tokens: 20, max: 20, refillRate: 20, lastRefill: Date.now() };

function refillBucket() {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(bucket.max, bucket.tokens + elapsed * bucket.refillRate);
  bucket.lastRefill = now;
}

async function waitForToken() {
  refillBucket();
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }
  // Wait until a token is available
  const waitMs = ((1 - bucket.tokens) / bucket.refillRate) * 1000;
  await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
  refillBucket();
  bucket.tokens -= 1;
}

// Monthly request counter (informational, resets on process restart)
let monthlyRequests = 0;
let currentMonth = new Date().getMonth();

function trackRequest() {
  const now = new Date().getMonth();
  if (now !== currentMonth) {
    monthlyRequests = 0;
    currentMonth = now;
  }
  monthlyRequests += 1;
  return monthlyRequests;
}

/**
 * Make an authenticated request to the RentCast API.
 *
 * @param {string} path - API path (e.g. "/properties", "/avm/value")
 * @param {Record<string, string>} [params] - Query parameters
 * @returns {Promise<any>} Parsed JSON response
 * @throws {Error} On non-retryable failure or exhausted retries
 */
export async function rentcastRequest(path, params = {}) {
  if (!env.RENTCAST_API_KEY) {
    throw new Error("[RentCast] RENTCAST_API_KEY not configured");
  }

  const base = env.RENTCAST_API_BASE;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  const url = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForToken();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const count = trackRequest();
      console.log(`[RentCast] ${path} (attempt ${attempt + 1}, monthly #${count})`);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-Api-Key": env.RENTCAST_API_KEY,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return await response.json();
      }

      // Retry on 429 or 5xx
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] ?? 4000;
        console.warn(`[RentCast] ${path} returned ${response.status}, retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        lastError = new Error(`RentCast API ${response.status}`);
        continue;
      }

      // Non-retryable error
      const body = await response.text().catch(() => "");
      throw new Error(`RentCast API ${response.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      clearTimeout(timeout);

      if (err.name === "AbortError") {
        lastError = new Error(`[RentCast] ${path} timed out after ${TIMEOUT_MS}ms`);
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          console.warn(`[RentCast] ${path} timed out, retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      } else if (err.message?.startsWith("RentCast API")) {
        throw err;
      } else {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          console.warn(`[RentCast] ${path} failed: ${err.message}, retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
    }
  }

  throw lastError || new Error(`[RentCast] Request failed`);
}
