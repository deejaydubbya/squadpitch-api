# SquadAds Exports — Production Reference

This is the implementation reference for SquadAds export-only MVP
(ads-01 through ads-11). Read this before changing anything in
`domains/ads/exporters/` or modifying the readiness validator.

---

## What SquadAds is

SquadAds turns a campaign / SquadSite page / post / property / idea
into a structured **ad package**: 2–3 creative variants, a target
audience suggestion, a budget suggestion, a destination URL, and
optional compliance + review notes. The package is workspace-scoped
(tenant-scoped at every database read; see ads-01) and goes through
a deterministic readiness + compliance gate (ads-02) before it can
be exported.

## What SquadAds does NOT do

- **SquadAds does not launch ads.** No code in this repo calls any
  ad platform's publish API.
- **SquadAds does not spend money.** Budget fields are
  recommendations; the user enters them in Meta Ads Manager / Google
  Ads / TikTok / LinkedIn / Pinterest themselves.
- **SquadAds does not bypass platform ad review.** The user submits
  the assembled campaign through each platform's own review queue.
- **SquadAds does not produce a universal one-click import file.**
  There is no JSON / XML / CSV format that every ad platform
  accepts. Each export is either an internal canonical bundle, a
  human brief, a starter file for one platform's editor, or a setup
  worksheet — clearly labeled per export.

This positioning is enforced in:
- UI copy on the ads index, new-package wizard, and detail page.
- `platformNotes` on every exporter descriptor.
- `isDirectImport` / `importStyle` / `requiresPlatformTemplateReview`
  flags returned with every export response.

---

## Export catalog

Run `GET /api/v1/workspaces/:id/ads/export-formats` to read the
authoritative catalog at runtime. The shape of each descriptor
is documented at `domains/ads/exporters/index.js#listExporters`.

| Format slug                 | Output     | Platform   | `isDirectImport` | What it is |
| --------------------------- | ---------- | ---------- | ---------------- | ---------- |
| `squadads_json`             | `.json`    | squadpitch | false            | Internal canonical bundle. Aliases: `json`. |
| `agency_markdown`           | `.md`      | any        | false            | Human-readable brief. Aliases: `markdown`, `md`. |
| `meta_launch_sheet`         | `.md`      | meta       | false            | Markdown launch brief for Facebook + Instagram. |
| `linkedin_launch_sheet`     | `.md`      | linkedin   | false            | Markdown launch brief for LinkedIn Campaign Manager. |
| `pinterest_launch_sheet`    | `.md`      | pinterest  | false            | Markdown launch brief for Pinterest Ads Manager. |
| `google_ads_editor_csv`     | `.csv`     | google     | false            | Starter Responsive Search Ad rows for Google Ads Editor. `importStyle: 'google_ads_editor_csv'`. |
| `tiktok_bulk_template_csv`  | `.csv`     | tiktok     | false            | Setup worksheet for TikTok Ads Manager's bulk template. `requiresPlatformTemplateReview: true`. |

### Why every `isDirectImport` is `false`

Each platform's import surface has its own quirks (account-specific
IDs, mandatory conversion-event mapping, asset-library uploads,
campaign-type selection). Setting `isDirectImport: false` keeps the
UI honest: the user always sees "starter file — review in editor"
or "setup brief" instead of "one-click upload". Future XLSX support
for true bulk-import targets can flip this per format without
changing the registry shape.

---

## Platform-specific notes

Authoritative spec hints live in `domains/ads/exporters/_platformSpecs.js`.
The same text appears in the launch sheet's `## Creative specs`
section so the media buyer doesn't need to re-look-it-up.

### Meta (Facebook + Instagram)
- Use `meta_launch_sheet`.
- Square 1:1 (1080×1080) + vertical 4:5 (1080×1350) work everywhere.
- Stories / Reels need 9:16 (1080×1920).
- Pixel + conversion event mapping happens at the ad-set level, not
  the package level.
- HOUSING packages get a **Special Ad Category: HOUSING** block at
  the top of the brief with 4 checkboxes (set category, no
  ZIP-only, no narrow age/gender, copy review).

### Google Ads
- Use `google_ads_editor_csv`.
- Defaults to Search RSAs, status=Paused, budget type=Daily.
- Field-length truncation warnings flow back in `res.warnings[]`
  (Headline > 30, Description > 90, etc.) — no silent loss.
- Display / Performance Max would need different exporters; not
  built yet.

### TikTok
- Use `tiktok_bulk_template_csv`.
- 9:16 vertical video is the strong default; hook + brand mention
  in the first 3 seconds materially impacts cost.
- The CSV is NOT a TikTok import file. TikTok bulk-edit uses an
  account-specific XLSX downloaded from inside Ads Manager. The
  worksheet's columns match TikTok's template; user pastes rows in.
- Assets must be uploaded to TikTok's asset library directly — URLs
  in the worksheet are reference only.

### LinkedIn
- Use `linkedin_launch_sheet`.
- LinkedIn's strongest filters are job title, seniority, company
  size, industry, and skills. The brief surfaces SquadAds interests
  as inspiration but the user translates inside Campaign Manager.
- LinkedIn does not surface a Special Ad Category UI like Meta, but
  the Fair Housing Act still applies — the brief calls this out.
- Insight Tag is LinkedIn's equivalent of the Meta Pixel.

### Pinterest
- Use `pinterest_launch_sheet`.
- Pinterest needs the actual image/video file uploaded to its
  asset library — URLs are reference only. The Pins section of
  the brief opens with a prominent reminder.
- Vertical 2:3 (1000×1500) is the strong default; square/landscape
  underperforms in Pinterest's grid.
- Pinterest Tag is the equivalent of the Meta Pixel.

---

## Fair Housing + Special Ad Category guardrails (ads-02)

The HOUSING special category triggers the strictest validation in
the entire ads pipeline. Before a HOUSING package can be marked
READY:

1. **Audience age** must be `[18, 65]`. No narrower.
2. **Genders** must be `["all"]`. No `["male"]` / `["female"]`.
3. **No postal / ZIP targeting.** Any location with
   `kind in {postal, zip}` or any `zip`/`postalCode`/`postal_code`
   field rejects the package.
4. **No narrow custom-audience hints.** Custom audience entries
   with restricted-class implications are blocked.
5. **`housingRestricted: true`** must be set on the audience.

These checks live in `domains/ads/ads.service.js#validatePackageReady`
and run **at both** the READY transition AND at export time
(defense in depth — copy may have changed between mark-ready and
download).

### Protected-class copy linter (ads-02)

`domains/ads/ads.compliance.js` runs a deterministic regex linter
against every variant's `headline`, `primaryText`, `description`,
and `cta`. The phrase list covers:

- **Familial status:** `family-friendly`, `bachelor pad`, `empty nesters`, …
- **Age:** `young professionals`, `mature buyers`, `55 and older`, …
- **Religion:** `walk to church`, `near synagogue`, …
- **Race/ethnicity:** `diverse neighborhood`, `english-speaking`, …
- **Disability:** restricted-class implications around mobility / care.
- **Catch-alls:** `safe neighborhood`, `good schools`, `exclusive community`.

When a match fires, the package is rejected with
`COMPLIANCE_COPY_REVIEW_FAILED` and the response carries
`findings[]` with `{variantIndex, field, phrase, reason}` so the
FE can render a per-field fix list.

### Source of truth

> **Service-layer validation is the source of truth, not AI
> prompts.** The LLM generation prompt also includes Fair Housing
> guardrails, but the deterministic validator is what blocks
> READY / export. AI prompt warnings are not a compliance control.

---

## Preview vs Download (ads-03)

Every export endpoint takes an explicit `mode`:

- `mode: 'preview'` (default) — generates the bundle + bytes, does
  **not** mutate the package. Safe to call from a "Preview" button.
- `mode: 'download'` — also flips `READY → EXPORTED` and appends an
  entry to `exportsJson`.

Legacy `?download=1` query string maps to `mode: 'download'` and
also streams an attachment with the right `Content-Disposition` so
curl / Postman users get the file directly.

The FE's `ExportPanel` exposes Preview + Download as separate
buttons per format card; the previous "two buttons" pattern that
silently flipped status on preview is gone.

---

## Tenant scoping (ads-01)

Every ads read and write filters on `clientId`:

- `prisma.adPackage.findFirst({ where: { id, clientId } })` —
  cross-workspace package ids return 404, not 403, so we never leak
  existence across tenants.
- `assertAssetsOwned(clientId, ids)` — atomic check: any single
  cross-workspace media-asset id rejects the whole upsert with
  `MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN`.
- `sitePage.findFirst({ where: { id, clientId } })` for SITE_PAGE
  destinations — unpublished + cross-workspace pages fail the
  validator before reaching the URL builder.
- `mediaAsset.findMany({ where: { id: { in }, clientId } })` in the
  export bundle builder — legacy rows that pre-date validation
  never resolve to a foreign URL.

---

## Manual QA checklist (production beta)

Run through these in order in a real workspace before tagging a
release as production-ready.

### Happy path — Campaign → Site → Export
- [ ] In a workspace, open the Ads index. Click **New ad package**.
- [ ] Pick **Source: Campaign**, choose an existing campaign.
- [ ] Pick **Objective: Traffic**, set a name.
- [ ] Pick **Destination: SquadSite page**, choose a PUBLISHED page.
- [ ] Click **Generate ad package** → land on detail page with
      auto-generated creatives + audience + budget.
- [ ] Click **Mark ready** → no validation errors.
- [ ] In the Export panel, click **Preview** on `squadads_json` →
      modal opens with content; status stays READY.
- [ ] Click **Download** on `squadads_json` → `.json` file saves;
      status flips to EXPORTED.

### Compliance path — HOUSING package
- [ ] Create a new package from a **PROPERTY** source. Confirm the
      Special Ad Category is auto-detected as **HOUSING**.
- [ ] Try to set an audience location with `kind: postal` →
      `Mark ready` should fail with **READY_PRECONDITIONS_FAILED**
      and the missing[] list should mention
      "HOUSING audience cannot use postal/ZIP targeting".
- [ ] Edit a variant to include "family-friendly neighborhood" in
      the primary text. `Mark ready` should fail with
      **COMPLIANCE_COPY_REVIEW_FAILED** and the findings[] list
      should call out the variant + field + flagged phrase.
- [ ] Fix both, mark ready, **Download** `meta_launch_sheet` →
      confirm the Special Ad Category: HOUSING block appears at
      the top with the 4 checkboxes.

### Platform exports
- [ ] **Google CSV:** download `google_ads_editor_csv`, open in a
      spreadsheet. Header row + Campaign row (status=Paused) + Ad
      group row + N Ad rows. Final URL column has the UTM-applied
      destination.
- [ ] **TikTok CSV:** download `tiktok_bulk_template_csv`. Open in
      a spreadsheet. Confirm `Compliance Notes` column carries the
      housing note for HOUSING packages.
- [ ] **Meta launch sheet:** open the `.md` file. Confirm the
      brief renders cleanly with sections (Campaign / Destination /
      Audience / Budget / Creatives / Creative specs / SETUP
      CHECKLIST).
- [ ] **LinkedIn + Pinterest launch sheets:** confirm the
      Fair Housing block appears for HOUSING packages even though
      neither platform has a Special Ad Category UI.

### Asset workflow
- [ ] On a creative variant, click **Pick from library** → modal
      shows workspace assets only. Pick one. Save.
- [ ] Verify the launch sheet now shows the asset URL with the
      `(image · 1080×1350 · 240 KB)` suffix + alt text underneath.
- [ ] Try to make the picker show a cross-workspace asset — it
      can't. Confirm via API that `upsertCreative` with a forged
      cross-workspace asset id rejects with
      `MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN`.

### Frontend ergonomics
- [ ] Destination editor: switching to SITE_PAGE renders the
      SitePagePicker (title + slug + status pill), not a raw
      id text input.
- [ ] Picking a DRAFT page shows a yellow warning that mark-ready
      will fail until the page is Published.
- [ ] Readiness errors render as a checklist (missing[] for
      preconditions, per-field findings[] for the copy linter) —
      not just a flat headline.

---

## Known limitations (production beta scope)

- **No true platform launch.** Every export still requires the user
  to open the platform's editor and complete the campaign manually.
  A future "publish via Meta Marketing API" integration would
  require new permission scoping + ad-account linking that's out of
  scope for this MVP.
- **XLSX exports not yet built.** TikTok + LinkedIn bulk-edit
  formats are XLSX-based; we ship CSV worksheets that paste cleanly
  into those templates. Adding XLSX would need a new dependency
  (e.g. `exceljs`).
- **Reddit / X / YouTube exporters not yet built.** The registry
  is structured so adding a new platform = drop a file in
  `exporters/` + register it; no service changes needed.
- **`google_ads_editor_csv` covers Search RSAs only.** Display /
  Performance Max / Video need different column sets — separate
  format slugs when we add them.
- **Field-length warnings are post-truncation, not blocking.** The
  validator does not refuse READY for over-length copy; the
  exporter truncates with an ellipsis and surfaces a
  `FIELD_TRUNCATED` warning so the user can revise. Move to
  blocking if the warning-noise becomes an issue.

---

## Where the code lives

```
domains/ads/
  ads.service.js              — package CRUD + validatePackageReady
  ads.compliance.js           — protected-class copy linter
  ads.export.service.js       — exportPackage orchestrator
  ads.export.errors.js        — shared ExportError
  ads.routes.js               — HTTP surface (mounted under /api/v1)
  ads.schemas.js              — Zod request schemas
  exporters/
    bundle.js                 — canonical bundle builder
    index.js                  — registry + dispatch
    _helpers.js               — csvRow, csvEscape, truncate, …
    _platformSpecs.js         — static spec text per platform
    squadadsJson.js           — JSON canonical
    agencyMarkdown.js         — Markdown human brief
    metaLaunchSheet.js        — Meta launch brief
    linkedinLaunchSheet.js    — LinkedIn launch brief
    pinterestLaunchSheet.js   — Pinterest launch brief
    googleAdsEditorCsv.js     — Google Editor CSV starter
    tiktokBulkTemplateCsv.js  — TikTok bulk worksheet

tests/
  adsService.test.js                     — package CRUD + readiness
  adsReadinessGate.test.js               — validator + compliance linter (32 cases)
  adsExportDestinationUrl.test.js        — SITE_PAGE URL resolution
  adsExporterRegistry.test.js            — registry + per-format dispatch smoke
  adsGoogleAdsEditorCsv.test.js          — Google CSV deep dive
  adsTiktokBulkTemplateCsv.test.js       — TikTok worksheet deep dive
  adsMetaLaunchSheet.test.js             — Meta brief deep dive
  adsLinkedinPinterestLaunchSheets.test.js — LinkedIn + Pinterest parameterized
  adsAssetWorkflow.test.js               — asset tenant scoping + bundle enrichment
```

## Where the FE lives

```
src/app/(app)/workspaces/[clientId]/ads/
  page.tsx              — index (stats + list)
  new/page.tsx          — wizard
  [packageId]/page.tsx  — detail (editor + export panel + modal)
  _components/
    ExportPanel.tsx     — format catalog UI
    SitePagePicker.tsx  — destination editor SitePage picker
    AssetPicker.tsx     — creative asset library modal

src/hooks/useAds.ts     — React Query hooks + ExportFormatDescriptor type
```
