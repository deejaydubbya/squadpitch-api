# Multilingual Support

Squadpitch ships multilingual / bilingual support in phases. The full
phasing plan + audit findings live in `MULTILINGUAL_PLAN.md` (in the
parent `squadpitch/` working directory); this doc describes **what's
actually live today** and what each future phase will add.

## Today (Phase 0 — language foundation)

What ships in this phase:

- **Storage**: `Client.defaultLanguage` (workspace-wide default),
  `ContentPreferences.defaultLanguage` (workspace override hook,
  unused in Phase 0), `Campaign.language`, `Draft.language`,
  `SitePage.language` + `siblingPageId`, `Conversation.defaultReplyLanguage`,
  `AIReplySuggestion.language`. All nullable (or default `"en"`).
- **Supported codes**: `en` (English) and `es` (Spanish), defined in
  `squadpitch-api/lib/languages.js` and mirrored in
  `squadpitch-web/src/lib/languages.ts`.
- **API**: `PATCH /api/v1/workspaces/:id` (`UpdateClientSchema`) and
  `PUT /api/v1/workspaces/:id/content-preferences`
  (`ContentPreferencesUpdateSchema`) both accept `defaultLanguage`.
  `POST /api/v1/workspaces` (`CreateClientSchema`) accepts it at
  workspace-create time.
- **Helper**: `domains/studio/generation/resolveLanguage.js` —
  fallback chain `request → campaign → contentPreferences → client → "en"`.
  Not yet called by any generation path; Phase 1 wires it in.
- **Web UI**: workspace settings page has a Content Language picker;
  onboarding has a `LanguageSelectCard` shown right after
  `IndustrySelectCard` and before any generation runs. Selection
  flows through `createClient.mutateAsync` so workspaces are born
  in the user's chosen language.

What does **not** change in Phase 0:

- No generation behavior changes. Posts, campaigns, landing pages,
  and inbox replies are still written in English regardless of the
  workspace's `defaultLanguage`. That's Phase 1.
- No public-site bilingual variants. URLs still serve one page per
  slug. That's Phase 2.
- No dashboard translation. Every UI string in `squadpitch-web` and
  this admin app stays in English. That's Phase 3, and is explicitly
  deferred — the customer-facing content language matters far more.

### Future-ready languages

The data model accepts any ISO 639-1 code. The Phase-1 allow-list is
gated to `en`/`es`; to add a new one, edit
`squadpitch-api/lib/languages.js` (and the FE mirror) and add a
phrasebook entry in each industry's prompts module. The codes already
documented as the next batch:

| Code | Name |
|---|---|
| `fr` | French |
| `pt` | Portuguese |
| `zh` | Chinese |
| `ar` | Arabic — RTL audit required on the dashboard + public sites before enabling |

### `AdAudience.languagesJson` ≠ output language

The schema's `AdAudience.languagesJson` field (used by SquadAds) is
**audience targeting** — which languages the ad audience prefers,
not the language ad copy is written in. Do **not** read or write
this field for content-generation decisions. The output-language
gate lives in `lib/languages.js` and the model fields listed above.

## Roadmap

| Phase | What it ships |
|---|---|
| **Phase 0** (this doc) | Language storage + workspace picker + onboarding card. No generation behavior change. |
| **Phase 1** | `languageInstructions` helper threaded through `promptBuilder.js`, `aiGenerationService.js`, `sites.generation.service.js`, `inbox.service.js`. Per-content language pickers in campaign / post-editor / inbox UI. Industry prompt modules get phrasebook swaps. |
| **Phase 2** | Public site bilingual variants — `siblingPageId` two-row pattern, locale-prefixed routes on `squadpitch-sites`, language switcher, hreflang/canonical metadata, "Generate Spanish variant" button in PageEditor. |
| **Phase 3** (deferred) | Dashboard i18n framework via `next-intl`, incremental string extraction. |
| **Phase 4** | Additional locales (fr / pt / zh / ar). For `ar`, RTL audit required. |
