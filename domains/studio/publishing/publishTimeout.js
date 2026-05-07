// Timeout helper for channel-adapter publish calls.
//
// We race the adapter promise against a timeout because some social
// providers (TikTok video upload, LinkedIn multipart media upload) can
// hang under load and we don't want a worker pod stuck waiting forever.
//
// On timeout we throw a typed error the existing worker classifier treats
// as transient/retryable. The underlying adapter HTTP request is NOT
// aborted — orphaning one fetch per timeout is fine for our volumes and
// keeps the helper agnostic to whether the adapter supports AbortSignal.

import { env } from "../../../config/env.js";

const DEFAULT_TIMEOUT_MS = 45_000;

/** Read the configured adapter publish timeout, clamped to a sane range. */
export function getPublishTimeoutMs() {
  const raw = env.PUBLISH_ADAPTER_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  // Clamp: don't allow truly absurd values that would render the helper useless.
  // Min 1s (anything shorter is hostile to legit slow uploads but still
  // tractable in tests); max 5 min.
  return Math.min(Math.max(n, 1_000), 300_000);
}

/**
 * Race `promise` against a timeout. Returns the resolved value on success.
 * On timeout, rejects with `{ status: 504, code: "PROVIDER_TIMEOUT" }`.
 *
 * @param {Promise<T>} promise
 * @param {{ timeoutMs?: number, channel?: string }} [opts]
 * @returns {Promise<T>}
 */
export function withPublishTimeout(promise, { timeoutMs, channel } = {}) {
  const ms = timeoutMs ?? getPublishTimeoutMs();
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        channel
          ? `${channel} publish timed out after ${ms}ms`
          : `Publish timed out after ${ms}ms`
      );
      err.status = 504;
      err.code = "PROVIDER_TIMEOUT";
      err.channel = channel ?? null;
      err.timeoutMs = ms;
      reject(err);
    }, ms);
  });

  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer));
}
