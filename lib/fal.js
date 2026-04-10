// Fal.ai provider — wraps the @fal-ai/client SDK for media generation.
// Only submitGeneration() is needed; buildFalInput() is AI-persona-specific.

import { fal } from "@fal-ai/client";
import { env } from "../config/env.js";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!env.FAL_API_KEY) {
    throw Object.assign(
      new Error("FAL_API_KEY is not set — media generation disabled"),
      { status: 500, code: "FAL_NOT_CONFIGURED" }
    );
  }
  fal.config({ credentials: env.FAL_API_KEY });
  configured = true;
}

const FAL_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Submit a generation request to Fal and wait for completion.
 *
 * @param {{ modelId: string, input: object, timeout?: number, mode?: 'sync'|'queue', onQueueUpdate?: function }} params
 * @returns {Promise<{ externalJobId: string|null, images: Array, video: object|null, seed: number|null }>}
 */
export async function submitGeneration({ modelId, input, timeout, mode, onQueueUpdate }) {
  ensureConfigured();
  const timeoutMs = timeout ?? FAL_REQUEST_TIMEOUT_MS;

  // Queue mode — for long-running models (video gen).
  if (mode === "queue") {
    const result = await fal.subscribe(modelId, {
      input,
      pollInterval: 3000,
      timeout: timeoutMs,
      ...(onQueueUpdate && { onQueueUpdate }),
    });
    return {
      externalJobId: result.requestId ?? null,
      images: result?.data?.images ?? [],
      video: result?.data?.video ?? null,
      seed: result?.data?.seed ?? null,
    };
  }

  // Sync mode (default) — for fast models (image gen).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await fal.run(modelId, {
      input,
      abortSignal: controller.signal,
    });
    return {
      externalJobId: result.requestId ?? null,
      images: result?.data?.images ?? [],
      video: result?.data?.video ?? null,
      seed: result?.data?.seed ?? null,
    };
  } catch (err) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`Fal.ai request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
