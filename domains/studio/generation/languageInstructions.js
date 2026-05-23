// Phase 1 multilingual support — produces the natural-language
// directive injected into LLM system/user prompts so that
// customer-facing output (post bodies, captions, CTAs, alt text,
// landing-page copy, inbox replies) is generated in the selected
// language.
//
// English is the historical default; passing "en" (or nothing)
// returns an empty string so existing prompts are unchanged. Any
// unsupported / future code is normalized to "en" via the central
// `normalizeLanguage` helper, so a bad request can never produce a
// half-translated mix.
//
// Pair with `resolveLanguage.js` — that picks WHICH language to
// use; this builds the prompt fragment for that pick.

import { normalizeLanguage } from "../../../lib/languages.js";

// Strong, prescriptive Spanish directive. Phrased so the model
// keeps brand names, addresses, URLs, model/listing names, and
// internal JSON schema keys verbatim — only generated *values*
// translate. Without this guardrail GPT-4-class models will
// occasionally translate keys or quoted street addresses.
const SPANISH_DIRECTIVE = `LANGUAGE INSTRUCTIONS
- Generate ALL customer-facing output in Spanish (es).
- Do not mix English into body copy, CTAs, captions, hashtags, image guidance, alt text, landing-page sections, or inbox replies unless the brand name, product name, vehicle name, property name, or quoted customer text is already in English.
- Preserve brand names, proper nouns, URLs, addresses, model names, listing titles, vehicle names, and product names as written.
- Use a natural, professional marketing tone suitable for Spanish-speaking customers in the United States unless the brand context says otherwise.
- Do not translate JSON keys, enum values, internal IDs, URLs, or schema field names.`;

/**
 * Returns the LLM-facing language instruction block for `language`.
 *
 * - `"en"` (or missing / unsupported) → `""` so prompts stay
 *   identical to their pre-multilingual shape and existing snapshot
 *   tests don't churn.
 * - `"es"` → the Spanish directive above.
 *
 * The return value is intentionally a string (not an object) so
 * callers can join it into existing template strings with a simple
 * `\n${buildLanguageInstructions(lang)}\n` and not have to branch.
 */
export function buildLanguageInstructions(language) {
  const code = normalizeLanguage(language);
  if (code === "es") return SPANISH_DIRECTIVE;
  return "";
}
