# Squadpitch Sites — Editor MVP Implementation

**Status:** All seven Sites upgrade phases shipped
(sites-01 through sites-07).
**Date:** 2026-05-18
**Companion doc:** [`SITES_EDITOR_UPGRADE_PLAN.md`](./SITES_EDITOR_UPGRADE_PLAN.md) — phase-by-phase implementation log.
**Promise:** Squadpitch Sites is a **data-aware landing page builder**. Users create pages from property records, generate scaffolded drafts with AI grounded in real data, preview before publishing, and submit leads that carry source context — without breaking any existing published page.

---

## 1. Product Workflow

```
┌─ Properties tab ─────────────────────────────────────────────┐
│  + Add Property (manual)  ·  Import from URL (scraped+dedup) │
│  Property cards: photos, status, beds/baths/sqft             │
│  Edit / Archive / Create campaign                            │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌─ Sites tab → Generate with AI ───────────────────────────────┐
│  Step 1: Template (Property Listing / Open House /          │
│          Just Sold / Seller Lead / Buyer Lead /             │
│          Neighborhood Guide / Custom)                       │
│  Step 2: Pick source (property for property templates;      │
│          idea prompt for IDEA templates)                    │
│  Step 3 (custom only): Pick page goal                       │
│  → POST /workspaces/:id/site/pages/from-source              │
└──────────────────────────────────────────────────────────────┘
                            ↓
       ┌──────────────────────────────────────────┐
       │ Generation service:                      │
       │  ├─ resolveSource(sourceType, sourceId)  │
       │  ├─ buildSystemPrompt (+ template hint   │
       │  │   + fabrication-ban rules)            │
       │  ├─ buildUserPrompt (+ template hint)    │
       │  ├─ LLM emits page payload (blocks)      │
       │  ├─ normalizeGeneratedPage               │
       │  ├─ applyTemplateScaffold (if template)  │
       │  └─ applyPropertyDeterministicFields     │
       │     (if PROPERTY source)                 │
       └──────────────────────────────────────────┘
                            ↓
┌─ Page editor ────────────────────────────────────────────────┐
│  Source context panel (PROPERTY): thumb, address, price,    │
│    beds/baths/sqft, status pill, View link                  │
│  Status note: "Drafts are private until you publish" /      │
│    "This page is published; saves may go live after refresh"│
│  Edit / Preview toggle (Desktop / Mobile viewport)          │
│  Per-block: collapse, duplicate, move up/down, drag,        │
│    remove                                                   │
│  Block fields: image picker (Library / Property Photos /    │
│    Upload / URL), gallery multi-pick, Pull-from-property    │
│    actions on hero/key_details/gallery/paragraph            │
│  Lead-form block: form name, field count, Edit form +       │
│    View submissions deep-links                              │
│  Save draft  ·  Publish / Unpublish  ·  View live           │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌─ Public renderer (squadpitch-sites) ─────────────────────────┐
│  [client].squadpitchsites.com/[campaign]                    │
│  Resolves PUBLISHED page + forms; renders blocks via the    │
│  forward-compat dispatcher (unknown types skip)             │
│  LeadFormClient submits with pageId for context             │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Models

### `Site` (one per workspace)
`id`, `clientId` (unique), `status`, `themeJson`, `faviconUrl`, `ogDefaultImageId`, `createdBy`, `createdAt`, `updatedAt`, `pages[]`, `forms[]`.

### `SitePage`
- Identity: `id`, `siteId`, `clientId` (denormalized for public lookup), `slug` (unique per client)
- **Source attribution:** `sourceType: CAMPAIGN | PROPERTY | DATA_ITEM | IDEA`, `sourceId: string?`, legacy `campaignId?`
- Editorial: `title`, `description`, `pageGoal: LEAD_CAPTURE | LISTING | OFFER | EVENT | CONSULTATION`, `noIndex`
- Content: `blocksJson: Json` (single working column — see §6)
- SEO: `seoTitle`, `seoDescription`, `heroImageId`, `ogImageId`
- Publish: `status: DRAFT | PUBLISHED | UNPUBLISHED | ARCHIVED`, `publishedAt`, `revalidateSec`

### `LeadForm`
`id`, `siteId`, `clientId`, `name`, `fieldsJson` (`[{ key, label, type, required?, placeholder?, options? }]`), `successAction`, `notifyEmail`, `submissions[]`.

### `FormSubmission`
`id`, `formId`, `clientId`, `campaignId?`, **`pageId?`** (populated via sites-06 with tenant-scoped validation), `dataJson`, `contactEmail`, `contactPhone`, `ipHash`, `userAgent`, `referer`, `status: NEW | PROCESSED | SPAM`.

### `WorkspaceDataItem` (`type: PROPERTY`)
The canonical property record. Spinstr425 promoted PROPERTY to a first-class type with intake-time dedup; sites-01 standardized the photo shape:

| Field | Type | Role |
|---|---|---|
| `imageUrl` | `string \| null` | Primary photo URL — back-compat with every reader |
| `images` | `string[]` | All photo URLs in order — back-compat |
| `_photos` | `Array<{ url, source: 'upload'\|'external_url'\|'import'\|'media_library', publicId?, alt?, isPrimary? }>` | Richer metadata |

Read precedence: `_photos[isPrimary] > imageUrl > images[0]` (used by PropertyCard, Sites source panel, Sites media picker, Autopilot detector).

### `MediaAsset`
Cloudinary-backed, server-side signed upload via `services/storage/imageStorage.js`. Used by both the Property modal photo picker and the Sites editor media picker.

**No migrations were required across the seven phases.** The `imageId` column on hero/image blocks (declared pre-sites) is now populated when applicable. `FormSubmission.pageId` (already existed) is now populated.

---

## 3. Block Catalog

Block types and their key fields. All blocks render through the dispatcher in `squadpitch-sites/lib/pageBlocks/index.tsx`. Unknown types are silently skipped (forward-compat).

| Type | Required fields | Optional fields | Sites editor surface |
|---|---|---|---|
| `hero` | — | `headline`, `subheadline`, `imageUrl`, `imageId` | ImageField + Pull-from-property |
| `paragraph` | `body` | — | Textarea + Pull-from-property |
| `image` | `imageUrl` | `imageId`, `alt`, `caption` | ImageField |
| `cta` | `label`, `href` | — | Two-input form |
| `lead_form` | `formId` | — | Form picker + context card (name + field count + Edit + View submissions links) |
| `gallery` | `imageUrls[]` | `layout: 'grid' \| 'carousel'` | GalleryField + Pull-from-property |
| `key_details` | `items: [{label, value}]` | `heading` | Repeatable rows + Pull-from-property |
| `testimonial` | `quote` | `author`, `role`, `imageUrl`, `imageId` | ImageField (headshot) |
| `faq` | `items: [{question, answer}]` | `heading` | Repeatable Q&A rows |
| `contact` | — | `heading`, `phone`, `email`, `address`, `socials[]` | Multi-input form |

---

## 4. AI Generation

### Templates (sites-05)

| Key | pageGoal | Scaffold (in order) | Notes |
|---|---|---|---|
| `property_listing` | LISTING | hero → key_details → gallery → paragraph → cta → lead_form → contact | Photos + facts deterministic |
| `open_house` | EVENT | hero → key_details → gallery → paragraph → cta → lead_form → contact | Property-linked |
| `just_sold` | LEAD_CAPTURE | hero → paragraph → gallery → cta → lead_form → contact | Prompt forbids quoting sale price unless in data |
| `seller_lead` | LEAD_CAPTURE | hero → paragraph → key_details → faq → cta → lead_form → contact | IDEA source |
| `buyer_lead` | LEAD_CAPTURE | hero → paragraph → faq → cta → lead_form → contact | IDEA source |
| `neighborhood_guide` | LEAD_CAPTURE | hero → paragraph → key_details → cta → lead_form → contact | Prompt forbids amenities/schools/walkability fabrication |
| (omitted) | — | (uses original 3-step wizard) | Custom path |

### Deterministic vs LLM fields (sites-02 + sites-05)

For PROPERTY sources, the LLM **only writes marketing copy**:
- hero headline + subheadline (subheadline often pulled from property facts)
- paragraph body
- CTA label / FAQ Q&A
- description-style text

Deterministic post-processing **always writes the facts**:
- hero `imageUrl` ← `_photos[isPrimary] > imageUrl > images[0]`
- `key_details.items` ← rows from `price / beds / baths / sqft / propertyType / yearBuilt / status` (only present fields emit rows)
- `gallery.imageUrls` ← deduped union of `_photos[]` + `images[]` + `imageUrl`
- `image.imageUrl` ← primary, only when missing
- `title` + `slug` ← from address, only when LLM left an "Untitled" placeholder

Idempotent — applying twice yields the same payload. Verified by `applyPropertyDeterministicFields` + `applyTemplateScaffold` tests.

### Fabrication-ban rules (sites-05)

System prompt now explicitly forbids:
- Market statistics (median price, days on market, inventory)
- School ratings, districts, or names
- Walkability / transit scores
- Specific neighborhood amenities not in the provided data
- Exact sale prices for sold listings unless they appear in the data
- Financing terms, mortgage rates, down-payment specifics

Rule: *"Only state these facts if they appear verbatim in the supplied source data. If unsure, omit the fact rather than guess."*

---

## 5. Endpoints

### Authenticated (workspace-scoped, `requireClientOwner`)

| Method | Path | Notes |
|---|---|---|
| GET / PATCH | `/api/v1/workspaces/:id/site` | Auto-creates Site on first GET |
| GET / POST | `/api/v1/workspaces/:id/site/pages` | List + create blank |
| GET / PATCH / DELETE | `/api/v1/workspaces/:id/site/pages/:pageId` | Page CRUD |
| POST | `/api/v1/workspaces/:id/site/pages/:pageId/publish` | Status → PUBLISHED + `publishedAt` |
| POST | `/api/v1/workspaces/:id/site/pages/:pageId/unpublish` | Status → DRAFT |
| POST | `/api/v1/workspaces/:id/site/pages/generate` | AI preview (no persist) |
| POST | `/api/v1/workspaces/:id/site/pages/from-source` | AI generate + persist + auto-create LeadForm. **Sites-05:** accepts optional `template`. |
| GET / POST / PATCH / DELETE | `/api/v1/workspaces/:id/site/forms[/:formId]` | LeadForm CRUD |
| GET / PATCH | `/api/v1/workspaces/:id/site/submissions[/:id]` | Submissions list + status update |
| GET | `/api/v1/workspaces/:id/business-data?type=PROPERTY` | Property fetch for source panel + media picker |
| POST | `/api/v1/workspaces/:id/listings/url` | URL analyze (scrape + validate) |
| POST | `/api/v1/workspaces/:id/listings/url/confirm` | URL save (intake dedup) |
| POST | `/api/v1/workspaces/:id/listings/manual` | Manual property create |
| POST | `/api/v1/workspaces/:id/assets/upload` | Cloudinary-backed image upload |

### Public (unauthenticated)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/public/sites/resolve?host=X&path=/Y` | Hostname + path → PUBLISHED page + forms map. The public renderer hits this. |
| POST | `/api/v1/public/forms/:formId/submit` | Honeypot + rate-limited + IP-hashed. **Sites-06:** accepts `pageId` + `campaignId`; service tenant-scopes both before write. |

---

## 6. Save / Publish Mental Model (sites-04)

Single `blocksJson` column. `status` enum gates public visibility.

- **DRAFT**: working copy. Save updates the row; the page stays unreachable until Publish.
- **PUBLISHED**: working copy IS the live copy. Saving a published page updates the live URL once ISR revalidates. There is no separate "next published version" buffer.
- **UNPUBLISHED**: status flips back to DRAFT; `blocksJson` preserved.

Editor surfaces this truthfully:
- DRAFT note: *"Drafts are private until you publish. Use Preview to see what the page will look like."*
- PUBLISHED note: *"This page is published. Saving changes updates the working page and may appear live after the site refreshes."*

A real draft-vs-published split (`draftBlocksJson` + `publishedBlocksJson`) is **deferred** — flagged as a Known Limitation below.

---

## 7. Preview Architecture (sites-04)

**In-app authenticated preview, no public token.** The editor mirrors the public renderer in `sites/_components/PreviewRenderer.tsx` and shows it inside the dashboard's existing `requireClientOwner`-gated route.

- Edit / Preview toggle in the top bar.
- Desktop (1080px) / Mobile (390px) viewport widths.
- "Draft preview" badge so the user never confuses preview for the live URL.
- Lead-form blocks render as labeled placeholders (preview is for layout, not lead capture).
- Links inside the preview have `e.preventDefault()` so accidental clicks don't navigate away.

**Why not a token-based public preview route?** The shared `blocksJson` model means the public renderer already shows the latest save once ISR revalidates. A public preview would add new auth surface and a duplicate rendering path for marginal upside. If a future case demands true parity (e.g. ad-platform crawler validation against a draft), we'll revisit.

---

## 8. Media Picker (sites-03)

Reusable `MediaPickerModal` with four tabs:

| Tab | When it appears | Source |
|---|---|---|
| Property Photos | only when `page.sourceType === 'PROPERTY'` | `dataJson.images[]` via normalizer |
| Library | always | `useAssets(clientId, { status: READY, assetType: image })` |
| Upload | always | `useUploadAsset` → Cloudinary signed upload |
| URL | always | Free-text paste |

Modes: `single` (used by hero / image / testimonial via `ImageField`); `multi` (used by gallery via `GalleryField`).

**`imageId` strategy:** write both `imageUrl` (always) + `imageId` (when picker returns one). Public renderer continues to read only `imageUrl` — zero risk to existing pages. `imageId` is forward-looking metadata for a future signed-URL flow on private buckets.

---

## 9. Security Model

| Surface | Auth | Tenant scope |
|---|---|---|
| Dashboard routes (`/workspaces/:id/site/...`) | `requireClientOwner` | `clientId` from auth, validated against route param |
| Public resolve (`/public/sites/resolve`) | None | Host → client slug lookup; only PUBLISHED pages returned |
| Public submit (`/public/forms/:formId/submit`) | None (rate-limited + honeypot) | `form.clientId` used to scope `pageId` + `campaignId` on the FormSubmission row |
| Media upload | `requireClientOwner` | Asset row gets `clientId` from route param |
| Preview | `requireClientOwner` (dashboard route) | Owner can only preview their workspace's pages |
| Cloudinary credentials | Server-side only | `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` in API env; never exposed to FE |

**Key invariants pinned by tests:**
- Cross-workspace `pageId` / `campaignId` on form submit → silently nulled (`sitesPublicSubmitScoping.test.js`)
- Unknown block type → silently skipped, page renders the rest (`safety.test.ts`)
- `javascript:` / `data:` / `vbscript:` / `file:` URLs → blocked by `isSafeUrl` (`safety.test.ts`)
- Cross-workspace property fetch → `findFirst({ clientId, id })` returns null
- `auto_publish_guarded` mode (Autopilot, unrelated but adjacent) → rejected on save

---

## 10. Property Photo Flow (sites-01)

End-to-end:
1. User clicks **+ Add Property** or **Import from URL** on the Properties tab.
2. Import path: `useListingUrlImport` analyzes the URL → `useListingUrlConfirm` saves via `listingIngestion.confirmUrlListing` → intake dedup on MLS id / listingUrl / normalized street.
3. Manual path: `useManualListingImport` → `listingIngestion.ingestManualListing` → same dedup pipeline.
4. Photos: `useUploadAsset` → server → Cloudinary `upload_stream` (signed) → returns `MediaAsset` with `url` + `publicId`.
5. Save merges photos into `dataJson.imageUrl` + `dataJson.images[]` + `dataJson._photos[]`.
6. Sites editor's media picker reads `images[]` for the Property Photos tab.
7. Autopilot's detector reads `_photos[isPrimary] > imageUrl > images[0]` for the recommendation payload.

Same shape, three readers, all back-compat with pre-sites-01 rows.

---

## 11. Tests + Coverage

Final baseline (2026-05-18):

| Repo | Suite | Result |
|---|---|---|
| squadpitch-api | `npx vitest run` | **984/984 passing** |
| squadpitch-web | `npx vitest run` | **340/340 passing** |
| squadpitch-web | `npx tsc --noEmit` | clean |
| squadpitch-sites | `npm test` (sites-07) | **43/43 passing** |
| squadpitch-sites | `npx tsc --noEmit` | clean |

Key sites-specific test files:
- `squadpitch-api/tests/sitesService.test.js` — slug extraction, IP hashing, honeypot, form-field validation
- `squadpitch-api/tests/sitesPropertyDeterministic.test.js` (sites-02) — 13 cases pinning the deterministic property fill
- `squadpitch-api/tests/sitesTemplateScaffolds.test.js` (sites-05) — 21 cases pinning template catalog + scaffold pass + schema
- `squadpitch-api/tests/sitesPublicSubmitScoping.test.js` (sites-06) — 8 cases pinning tenant-scoping
- `squadpitch-sites/lib/pageBlocks/safety.test.ts` (sites-07) — **43 cases pinning the dispatcher's safety contract** (URL safety, unknown-block skip, malformed-input drops, legacy back-compat)
- `squadpitch-web/src/lib/property/normalize.test.ts` (sites-02) — 17 cases pinning the property normalizer
- `squadpitch-web/src/components/studio/propertyPhotos.helpers.test.ts` (sites-01) — 17 cases pinning photo state machine

---

## 12. Known Limitations

These are documented and intentionally deferred — not blockers for the MVP.

1. **No `draftBlocksJson` / `publishedBlocksJson` split.** Saving a published page updates the live URL once ISR revalidates. A real split would require a schema migration + buffer-and-publish flow; flagged for when "edit while published without going live" becomes a real product requirement.
2. **No full drag-and-drop canvas editor.** Block-tree editing stays the editorial primitive (with collapse/duplicate/move/drag controls in sites-06). A visual canvas is a major rewrite, not on the roadmap.
3. **No version history.** Each save overwrites. Undo within a session works via the local React state; persisted version history is out of scope.
4. **Six templates only** (`property_listing` / `open_house` / `just_sold` / `seller_lead` / `buyer_lead` / `neighborhood_guide`). No car-sales or other-industry templates yet.
5. **No public preview tokens.** The in-app preview covers the editing use case. A future ad-platform crawler scenario could justify token-based public preview.
6. **Media library asset rows aren't linked to properties.** Photos uploaded via the Property modal write URLs onto `dataJson` but don't get an FK from `MediaAsset` to the property. Query path is "use the URL"; relational lookup would need a join table.
7. **`MediaPickerModal` doesn't paginate.** Workspaces with thousands of images would need search + pagination on the assets list.
8. **No drag-drop on the Upload tab** — file-input click only.
9. **No "Create new form" inline in the lead-form block.** Forms-tab flow still owns creation.
10. **No per-form submissions count / last-submission date** in the lead-form context card. Would need a new `useFormStats` hook.
11. **`pageId` filter on submissions list endpoint not yet exposed.** The deep-link from the lead-form block uses `?formId=…`; `?pageId=…` is a small additive change.
12. **Public renderer parity is by visual review.** No automated diff between `PreviewRenderer` (web) and `lib/pageBlocks/index.tsx` (sites). Drift would be a future hardening concern; shared-package extraction is the long-term answer.
13. **`open_house` template doesn't surface the open-house date directly in the hero** — data is in `dataJson.events`; `applyPropertyDeterministicFields` could be extended.
14. **`templateUsed` returned in API response but not yet shown** as a source-panel badge.

None of these are safety, correctness, or back-compat issues — they're product polish items for a future pass.

---

## 13. Confirmation

**Existing published pages remain compatible across all seven phases.** No schema migration was required. No `blocksJson` shape change is breaking. Every new field (`imageId` on hero/image, `_photos` on properties, `pageId` on submissions, `template` on the generation request) is additive and optional. Old pages with only `imageUrl` continue to render unchanged; old form submissions without `pageId` continue to work; the public renderer's unknown-block-skip behavior absorbs any forward-incompatible block types from a future API rollout.

The public renderer's safety invariants are now pinned by 43 dedicated tests — the first automated coverage that repo has ever had.
