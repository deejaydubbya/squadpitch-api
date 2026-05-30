// Ads-02 — protected-class copy linter for HOUSING-restricted ad
// packages. Deterministic guard so READY + export refuse copy
// that the legal team has called out as risky, instead of
// relying on AI-prompt hand-waving.
//
// The phrase list is intentionally conservative — only patterns
// that are real protected-class risk under Fair Housing /
// CFPB / similar regimes. Easy to extend; each entry is a
// word-boundary case-insensitive regex.
//
// References:
//   - HUD Fair Housing Act guidance
//   - Meta Special Ad Categories (Housing) compliance docs
//   - NAR Code of Ethics, Article 10
//
// Scope: lints `headline`, `primaryText`, `description` per
// creative. Returns a flat list of findings the caller turns
// into a 400 with code COMPLIANCE_COPY_REVIEW_FAILED.

const FAIR_HOUSING_BLOCKED_PHRASES = [
  // Familial status
  { phrase: "family-friendly", reason: "implies familial-status preference" },
  { phrase: "families only", reason: "explicit familial-status preference" },
  { phrase: "perfect for families", reason: "implies familial-status preference" },
  { phrase: "great for kids", reason: "implies familial-status preference" },
  { phrase: "no children", reason: "explicit familial-status exclusion" },
  { phrase: "bachelor pad", reason: "implies marital/familial-status preference" },
  { phrase: "empty nesters", reason: "implies familial-status preference" },
  { phrase: "single", reason: "may imply marital-status preference" },
  { phrase: "couples only", reason: "marital-status preference" },
  // Age
  { phrase: "young professionals", reason: "age preference" },
  { phrase: "young couples", reason: "age preference" },
  { phrase: "mature buyers", reason: "age preference" },
  { phrase: "seniors only", reason: "age preference" },
  { phrase: "55 and older", reason: "age preference (use HUD-approved senior housing wording)" },
  { phrase: "adult community", reason: "age preference" },
  // Religion
  { phrase: "near church", reason: "religious-preference signal" },
  { phrase: "near synagogue", reason: "religious-preference signal" },
  { phrase: "near mosque", reason: "religious-preference signal" },
  { phrase: "walk to church", reason: "religious-preference signal" },
  { phrase: "walk to synagogue", reason: "religious-preference signal" },
  { phrase: "christian community", reason: "religious-preference signal" },
  { phrase: "catholic neighborhood", reason: "religious-preference signal" },
  // Race / ethnicity / national origin
  { phrase: "ethnic neighborhood", reason: "national-origin signal" },
  { phrase: "diverse neighborhood", reason: "race / national-origin signal" },
  { phrase: "english-speaking", reason: "national-origin signal" },
  { phrase: "english speaking", reason: "national-origin signal" },
  // Disability
  { phrase: "able-bodied", reason: "disability signal" },
  { phrase: "no wheelchair", reason: "disability exclusion" },
  // Catch-alls Fair Housing examiners commonly flag
  { phrase: "safe neighborhood", reason: "perceived racial/socioeconomic signal" },
  { phrase: "good schools", reason: "racial-proxy signal under HUD guidance" },
  { phrase: "exclusive community", reason: "exclusionary signal" },
  { phrase: "restricted", reason: "exclusionary signal" },
  { phrase: "private", reason: "may signal exclusion when paired with neighborhood" },
];

/**
 * Compile a regex once at module-load time. Word boundaries on
 * each side so `family-friendly` doesn't match inside `non-family-friendly`.
 * `phrase.replace` escapes regex specials so `55 and older` works.
 */
function compileRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i");
}

const COMPILED = FAIR_HOUSING_BLOCKED_PHRASES.map(({ phrase, reason }) => ({
  phrase,
  reason,
  regex: compileRegex(phrase),
}));

/**
 * Lint creative copy for a given special category. Returns a flat
 * array of findings. Empty array = clean.
 *
 * @param {Array<{variantIndex, headline, primaryText, description}>} creatives
 * @param {string} specialCategory — HOUSING / EMPLOYMENT / CREDIT / SOCIAL_ISSUES / NONE
 */
export function lintCreativeCopy(creatives, specialCategory) {
  if (!creatives || creatives.length === 0) return [];
  // Today only HOUSING has a phrase list. EMPLOYMENT/CREDIT/
  // SOCIAL_ISSUES are routed through the same gate but linted
  // with HOUSING's list — none of the included phrases are
  // employment/credit-safe either. Future: split by category.
  if (specialCategory === "NONE" || specialCategory == null) return [];

  const findings = [];
  for (const c of creatives) {
    for (const field of ["headline", "primaryText", "description"]) {
      const text = typeof c[field] === "string" ? c[field] : "";
      if (!text) continue;
      for (const { phrase, reason, regex } of COMPILED) {
        if (regex.test(text)) {
          findings.push({
            variantIndex: c.variantIndex ?? null,
            field,
            phrase,
            reason,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * The HOUSING-restricted phrase list, exposed for tests + future
 * UI surfaces that want to render the rule book to the user.
 */
export const HOUSING_BLOCKED_PHRASES = Object.freeze(
  FAIR_HOUSING_BLOCKED_PHRASES.map((p) => p.phrase),
);
