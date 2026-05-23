// Resolve the language a generation should run in.
//
// Phase 0 of the multilingual rollout (prompt 02) adds this helper
// so every Phase 1 generation entry point — `aiGenerationService`,
// `sites.generation.service`, `inbox.service` — shares ONE fallback
// chain. Without this helper each call site would re-invent the
// chain inconsistently.
//
// Phase 0 does NOT yet call this from generation code (that's prompt
// 03 / Phase 1). It exists, is tested, and is ready.
//
// Resolution order:
//   1. `requestedLanguage`                — caller-supplied (e.g. request body)
//   2. `campaign.language`                — campaign-level override
//   3. `contentPreferences.defaultLanguage` — per-workspace default
//   4. `client.defaultLanguage`           — workspace-wide default
//   5. `fallback`                         — caller-supplied final fallback
//   6. `"en"`                             — built-in safety net
//
// Every layer flows through `normalizeLanguage`, so an unsupported
// or malformed value at any step silently drops to the next. The
// result is always a code in the SUPPORTED_LANGUAGES allow-list.

import {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  normalizeLanguage,
} from "../../../lib/languages.js";

/**
 * @typedef {Object} ResolveLanguageInput
 * @property {string|null|undefined} [requestedLanguage]
 *   Explicit language from the request (e.g. POST body `language`).
 * @property {{ language?: string|null }|null|undefined} [campaign]
 *   The Campaign row this generation belongs to, if any.
 * @property {{ defaultLanguage?: string|null }|null|undefined} [contentPreferences]
 *   The workspace's ContentPreferences row.
 * @property {{ defaultLanguage?: string|null }|null|undefined} [client]
 *   The workspace's Client row.
 * @property {string} [fallback]
 *   Final fallback before the built-in "en" safety net. Defaults to "en".
 */

/**
 * @param {ResolveLanguageInput} input
 * @returns {string}  A code in SUPPORTED_LANGUAGES (currently "en" | "es").
 */
export function resolveLanguage(input = {}) {
  const {
    requestedLanguage,
    campaign,
    contentPreferences,
    client,
    fallback = DEFAULT_LANGUAGE,
  } = input;

  // Walk the chain. Each candidate is sanitized — only a value that
  // (a) is a non-empty string AND (b) lands in the supported set
  // gets returned. Everything else drops to the next layer.
  const candidates = [
    requestedLanguage,
    campaign?.language,
    contentPreferences?.defaultLanguage,
    client?.defaultLanguage,
    fallback,
  ];

  for (const c of candidates) {
    if (isSupportedLanguage(c)) {
      // normalizeLanguage handles trim + case so callers can pass
      // "EN" or " es " without surprises.
      return normalizeLanguage(c);
    }
  }

  // Should never happen — the built-in fallback is "en" which is
  // always supported — but guard anyway so future supported-list
  // edits can't accidentally produce undefined.
  return DEFAULT_LANGUAGE;
}
