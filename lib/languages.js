// Supported customer-facing content languages.
//
// Phase 0 of the multilingual rollout ships English + Spanish for
// generated content (campaign copy, social posts, captions, CTAs,
// landing-page copy, inbox AI replies). The registry is shaped so
// fr / pt / zh / ar can be added later without a schema change —
// every model that stores `language` accepts any ISO 639-1 code, and
// only the `SUPPORTED_LANGUAGES` allow-list gates user-facing
// selection.
//
// NOTE: `AdAudience.languagesJson` (prisma/schema.prisma) is *ads
// targeting* — which languages the audience speaks, not the language
// of generated copy. Do NOT reuse it for output-language decisions.

export const DEFAULT_LANGUAGE = "en";

export const SUPPORTED_LANGUAGES = Object.freeze([
  Object.freeze({ code: "en", label: "English", nativeLabel: "English" }),
  Object.freeze({ code: "es", label: "Spanish", nativeLabel: "Español" }),
]);

// Future-ready codes. Listed here for documentation and so a code
// review catches accidental drift between the schema, the API, and
// this allow-list. To enable one, move it into SUPPORTED_LANGUAGES.
//
//   fr → French   (Français)
//   pt → Portuguese (Português)
//   zh → Chinese  (中文)
//   ar → Arabic   (العربية) — RTL audit required before enabling
//
// When adding a new language:
//   1. Add the entry to SUPPORTED_LANGUAGES above.
//   2. Add a phrasebook entry to each industry's prompts module.
//   3. (Arabic only) audit the public-site renderer + dashboard for
//      RTL layout correctness.
export const FUTURE_LANGUAGE_CODES = Object.freeze(["fr", "pt", "zh", "ar"]);

const SUPPORTED_CODE_SET = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isSupportedLanguage(code) {
  return (
    typeof code === "string" &&
    SUPPORTED_CODE_SET.has(code.trim().toLowerCase())
  );
}

/**
 * Coerce any input to a supported language code. Unknown / falsy
 * input returns DEFAULT_LANGUAGE so callers don't have to special-case
 * null. Accepts mixed-case like `"EN"` or `"En"` (returns `"en"`).
 *
 * @param {unknown} code
 * @returns {string}  Always a code in SUPPORTED_LANGUAGES.
 */
export function normalizeLanguage(code) {
  if (typeof code !== "string") return DEFAULT_LANGUAGE;
  const lower = code.trim().toLowerCase();
  return SUPPORTED_CODE_SET.has(lower) ? lower : DEFAULT_LANGUAGE;
}

/**
 * Human label for a language code, in English. Useful for log lines
 * and admin UI. Returns the code itself when the language isn't in
 * the registry (don't throw — logs shouldn't crash on a typo).
 *
 * @param {unknown} code
 * @returns {string}
 */
export function getLanguageLabel(code) {
  if (typeof code !== "string") return DEFAULT_LANGUAGE;
  const lower = code.toLowerCase();
  const entry = SUPPORTED_LANGUAGES.find((l) => l.code === lower);
  return entry ? entry.label : code;
}
