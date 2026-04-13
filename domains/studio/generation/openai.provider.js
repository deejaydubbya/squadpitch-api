// OpenAI provider for Content Studio.
//
// The ONLY file in the codebase that imports the `openai` SDK. All Content
// Studio generation calls flow through this module so swapping models or
// providers is a single-file change. Mirrors the shape of `lib/engineClient.js`
// (custom error class + timeout via AbortController + structured error codes).

import OpenAI from "openai";
import { env } from "../../../config/env.js";
import { selectModel } from "../../billing/aiModelRouter.js";
import { recordServiceSuccess, recordServiceFailure } from "../../billing/serviceHealth.service.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAIProviderError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message);
    this.name = "OpenAIProviderError";
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

let _client = null;

/**
 * Lazy singleton OpenAI client. Throws a structured error if
 * OPENAI_API_KEY is not configured.
 */
export function getClient() {
  if (_client) return _client;
  if (!env.OPENAI_API_KEY) {
    throw new OpenAIProviderError(
      "OPENAI_API_KEY is not configured",
      { code: "OPENAI_NOT_CONFIGURED", status: 503 }
    );
  }
  _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _client;
}

/**
 * Call the OpenAI chat completions API with a structured JSON schema response
 * format and parse the result.
 *
 * @param {object} params
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {string} [params.model]
 * @param {object} [params.responseFormat] - OpenAI `response_format` object
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{ parsed: object, model: string, usage: object }>}
 */
export async function generateStructuredContent({
  systemPrompt,
  userPrompt,
  model,
  taskType,
  responseFormat,
  temperature,
  timeoutMs,
}) {
  const client = getClient();
  const selectedModel = model ?? (taskType ? selectModel(taskType) : null) ?? env.OPENAI_DEFAULT_MODEL ?? "gpt-4o-mini";
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  let completion;
  try {
    completion = await client.chat.completions.create(
      {
        model: selectedModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: responseFormat ?? { type: "json_object" },
        ...(temperature != null && { temperature }),
      },
      { signal: controller.signal }
    );
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      recordServiceFailure("openai").catch(() => {});
      throw new OpenAIProviderError(
        `OpenAI request timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        { code: "OPENAI_TIMEOUT", cause: err }
      );
    }
    if (err instanceof OpenAIProviderError) throw err;
    recordServiceFailure("openai").catch(() => {});
    throw new OpenAIProviderError(
      `OpenAI request failed: ${err?.message ?? String(err)}`,
      { code: "OPENAI_REQUEST_FAILED", status: err?.status, cause: err }
    );
  }
  clearTimeout(timer);
  recordServiceSuccess("openai").catch(() => {});

  const choice = completion?.choices?.[0];
  const content = choice?.message?.content;
  if (!content || typeof content !== "string") {
    throw new OpenAIProviderError("OpenAI returned empty response body", {
      code: "OPENAI_EMPTY_BODY",
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new OpenAIProviderError("OpenAI returned invalid JSON", {
      code: "OPENAI_INVALID_JSON",
      cause: err,
    });
  }

  return {
    parsed,
    model: completion.model ?? selectedModel,
    usage: completion.usage ?? null,
  };
}
