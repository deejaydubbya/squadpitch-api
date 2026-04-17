// Thin Replicate client for SAM 2 segmentation.
//
// This is the ONLY module in the codebase that imports the `replicate` SDK.
// Swap model IDs or providers here without touching callers.

import Replicate from "replicate";
import { env } from "../../../config/env.js";
import {
  recordServiceSuccess,
  recordServiceFailure,
} from "../../billing/serviceHealth.service.js";

export class ReplicateProviderError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message);
    this.name = "ReplicateProviderError";
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

let _client = null;

/** Lazy singleton Replicate client. Throws if token missing. */
export function getClient() {
  if (_client) return _client;
  if (!env.REPLICATE_API_TOKEN) {
    throw new ReplicateProviderError(
      "REPLICATE_API_TOKEN is not configured",
      { code: "REPLICATE_NOT_CONFIGURED", status: 503 }
    );
  }
  _client = new Replicate({ auth: env.REPLICATE_API_TOKEN });
  return _client;
}

/** Run a Replicate model and return its raw output (mask URLs, etc.). */
export async function runModel(modelRef, input, { timeoutMs = 90_000 } = {}) {
  const client = getClient();
  try {
    const output = await Promise.race([
      client.run(modelRef, { input }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new ReplicateProviderError(
            `Replicate request timed out after ${timeoutMs}ms`,
            { code: "REPLICATE_TIMEOUT" }
          )),
          timeoutMs,
        ),
      ),
    ]);
    recordServiceSuccess("replicate").catch(() => {});
    return output;
  } catch (err) {
    recordServiceFailure("replicate").catch(() => {});
    if (err instanceof ReplicateProviderError) throw err;
    throw new ReplicateProviderError(
      `Replicate request failed: ${err?.message ?? String(err)}`,
      { code: "REPLICATE_REQUEST_FAILED", status: err?.status, cause: err },
    );
  }
}
