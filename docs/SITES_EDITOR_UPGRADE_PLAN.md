# Squadpitch Sites — Editor Upgrade Plan

**Status:** Plan only. No code changes in this pass. Audit conducted
across `squadpitch-web`, `squadpitch-api`, and `squadpitch-sites` as
of 2026-05-18.

**Goal:** Lift Squadpitch Sites from a generic block editor into a
**data-aware landing-page builder**. Pages should know what
business object they came from (property, campaign, data item, idea)
and render with that data automatically, with first-class media and
form integration. Future industries (car sales, etc.) should plug in
without forking the schema.

---

## 1. Non-goals (hard guardrails)

1. **Do not break existing published pages.** Every block type in
   `lib/pageBlocks/index.tsx` (squadpitch-sites) must keep rendering;
   the renderer must keep its forward-compat "skip unknown block
   type" behavior. Net-new block types are allowed; renaming or
   removing existing ones is not.
2. **Do not break public rendering at squadpitchsites.com.** The
   public resolver (`/api/v1/public/sites/resolve`) shape stays
   stable. Any schema additions are additive.
3. **Do not delete page data.** `blocksJson` writes go through PATCH;
   no destructive operations.
4. **No mandatory migration this round.** New columns may be added
   in later phases with safe defaults; we never backfill in a way
   that touches existing PUBLISHED rows.
5. **No full visual website-builder rewrite.** Block-tree edits stay
   the editorial primitive; live preview is iframe-based, not a
   canvas drag-and-drop overhaul.
6. **Tenant isolation preserved.** `requireClientOwner` on every
   workspace-scoped route; `clientId` denormalized on `SitePage` and
   `LeadForm` for public lookup; no relaxation of either.

---

## 2. Current Architecture Map

### 2.1 Repos

| Repo | Role |
|---|---|
| `squadpitch-web` | Authenticated dashboard. Sites page list, page editor, AI generation wizard, forms+submissions management. |
| `squadpitch-api` | REST surface. Site/SitePage/LeadForm/FormSubmission persistence, AI generation service, public resolver. |
| `squadpitch-sites` | Public renderer at `[client].squadpitchsites.com/[campaign]`. Next 15 + React 19. Catch-all route, ISR. |

### 2.2 Models (`squadpitch-api/prisma/schema.prisma`)

**`Site` (l. 426)** — One per workspace (MVP constraint):
- `id`, `clientId` (unique)
- `status: SiteStatus` (DRAFT|PUBLISHED|UNPUBLISHED|ARCHIVED)
- `themeJson`, `faviconUrl`, `ogDefaultImageId`
- `pages: SitePage[]`, `forms: LeadForm[]`

**`SitePage` (l. 447)** — Has source attribution already:
- Identity: `id`, `siteId`, `clientId` (denormalized), `slug`
- **Source refs:** `campaignId` (legacy FK) + `sourceType: SiteSourceType` (CAMPAIGN|PROPERTY|DATA_ITEM|IDEA) + `sourceId: string?`. **This already exists. The editor only displays it; no autofill yet.**
- Editorial: `title`, `description`, `pageGoal: SitePageGoal` (LEAD_CAPTURE|LISTING|OFFER|EVENT|CONSULTATION), `noIndex`
- Content: `blocksJson: Json` (single working column — see §2.4)
- SEO: `seoTitle`, `seoDescription`, `heroImageId`, `ogImageId`
- Publish: `status: PageStatus`, `publishedAt`, `revalidateSec` (declared but not yet wired through to `revalidate` in the renderer)

**`LeadForm` (l. 490)** + **`FormSubmission` (l. 508)** — Per-site forms with field defs (`fieldsJson`), success action, optional notify email. Submissions carry `formId`/`pageId`/`campaignId` for source attribution.

### 2.3 Block schema (`squadpitch-web/src/hooks/useSites.ts:77-94`)

Ten variants, all `{ type, ...config }`:

| Type | Fields | Image fields |
|---|---|---|
| `hero` | `headline?`, `subheadline?`, `imageId?`, `imageUrl?` | both |
| `paragraph` | `body?` | — |
| `image` | `imageId?`, `imageUrl?`, `alt?`, `caption?` | both |
| `cta` | `label`, `href` | — |
| `lead_form` | `formId` | — |
| `gallery` | `imageUrls[]`, `layout?` | URL array only |
| `key_details` | `heading?`, `items: [{label, value}]` | — |
| `testimonial` | `quote`, `author?`, `role?`, `imageUrl?` | URL only |
| `faq` | `heading?`, `items: [{question, answer}]` | — |
| `contact` | `heading?`, `phone?`, `email?`, `address?`, `socials?` | — |

**`imageId` exists on `hero` and `image` but is never written by the editor.** The UI only writes `imageUrl` (free-text input). This is the seam where the media picker plugs in (Phase 2).

The same enum is mirrored in `squadpitch-api/domains/sites/sites.generation.service.js:63-73` (AI structured-output schema) and in `squadpitch-sites/lib/pageBlocks/index.tsx:26-68` (renderer dispatch).

### 2.4 Draft vs Published

**One column, gated by status.** `blocksJson` always holds the working copy. `status: PageStatus` (DRAFT|PUBLISHED|UNPUBLISHED|ARCHIVED) controls public visibility. The publish endpoint flips status + stamps `publishedAt`; the unpublish endpoint flips status back to DRAFT and leaves `blocksJson` intact (`sites.dashboard.service.js:147-157`).

**Consequence:** the public renderer always sees the latest save of a PUBLISHED page. There is **no separate draft preview** today — when the user clicks Save, the public site renders that exact content the next time ISR revalidates.

This is the architectural seam for Phase 3 (preview mode).

### 2.5 API surface (`squadpitch-api/domains/sites/sites.dashboard.routes.js`)

Owner-gated workspace-scoped routes:

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/:id/site` | Auto-creates Site on first access. |
| PATCH | `/workspaces/:id/site` | Theme / status / favicon updates. |
| GET | `/workspaces/:id/site/pages` | List. |
| POST | `/workspaces/:id/site/pages` | Create blank page. |
| GET | `/workspaces/:id/site/pages/:pageId` | Fetch. |
| PATCH | `/workspaces/:id/site/pages/:pageId` | Update (title/blocks/slug/seo/goal/noIndex). |
| POST | `/workspaces/:id/site/pages/:pageId/publish` | Status → PUBLISHED + `publishedAt`. |
| POST | `/workspaces/:id/site/pages/:pageId/unpublish` | Status → DRAFT. |
| DELETE | `/workspaces/:id/site/pages/:pageId` | Hard delete. |
| POST | `/workspaces/:id/site/pages/generate` | AI **preview** (no persist). |
| POST | `/workspaces/:id/site/pages/from-source` | AI generate **+ create** page (+ form if blocks include `lead_form`). |
| GET / POST / PATCH / DELETE | `/workspaces/:id/site/forms[/:formId]` | LeadForm CRUD. |
| GET / PATCH | `/workspaces/:id/site/submissions[/:id]` | Submissions list + status update. |

Public, unauthenticated (`squadpitch-api/domains/sites/public.routes.js`):

| Method | Path | Notes |
|---|---|---|
| GET | `/public/sites/resolve?host=X&path=/Y` | Hostname + path → PUBLISHED page + forms map. |
| POST | `/public/forms/:formId/submit` | Honeypot + IP rate-limited + IP-hashed. Spawns Inbox intake (idempotent on `sourceFormSubmissionId`). |

### 2.6 Public renderer (`squadpitch-sites`)

- `app/[campaign]/page.tsx` — catch-all for `/<slug>` on the customer's subdomain.
- `generateMetadata()` returns SEO title/description/robots from the API resolve response.
- `app/page.tsx` — root path; same resolve logic with empty path.
- `lib/pageBlocks/index.tsx` — dispatcher (`switch (block.type)`). Skips unknown types so older clients can roll out new block types in the API without breaking older renderers.
- Per-block components use inline styles + JSX escaping. No `dangerouslySetInnerHTML`.
- ISR: `revalidateSec` exists in the model but the renderer doesn't yet export `revalidate` per route. Live edits don't surface until the catch-all's Next.js cache invalidates.

### 2.7 Web editor (`squadpitch-web/src/app/(app)/workspaces/[clientId]/sites/_components/PageEditor.tsx`)

- Header card: title + slug inputs, publish/unpublish/save, source attribution badge (read-only), description, page-goal dropdown, SEO + robots collapsible.
- Block list: dnd-kit sortable. Each block renders a `SortableBlockCard` → `BlockFields` (per-type form, ~400 lines).
- Block adder: grid palette below the list — click adds a block.
- **Image inputs are plain text** (`<input type="text">`) — no thumbnail, no media picker, no upload.
- All state is local React; **save batches the whole page** on PATCH.

### 2.8 AI generation flow

- Web entry: `SiteCreateWizard.tsx` — 3-step wizard (source type → source pick → goal). Calls `useGeneratePageFromSource()`.
- API: `POST /site/pages/from-source` → `sites.generation.service.js`:
  - Loads client `BrandProfile` + `VoiceProfile` + historical campaigns for context.
  - Calls OpenAI structured output with `PAGE_OUTPUT_SCHEMA` (mirrors the block union).
  - Auto-creates a LeadForm if the AI emits a `lead_form` block with a placeholder formId.
  - Returns `{ page, generation, suggestedFormFields, sourceContext }`.

**Property pages today:** the wizard can pick PROPERTY as source, but the resulting blocks are LLM-generated free-form copy — there's no guarantee `key_details` will show the right address/price/beds/baths, no guarantee `gallery` will pull `dataJson.images`. This is the gap Phase 4 closes.

### 2.9 Media + Data APIs

**Assets:**
- `useAssets(clientId, filters)` → `GET /workspaces/:id/assets?status=READY&folderId=…&assetType=…&search=…`
- `useUploadAsset(clientId)` → `POST /workspaces/:id/assets/upload` (multipart)
- Existing `MiniMediaPicker` lives inside `AddDataItemModal.tsx` — not yet extracted for reuse.

**Properties (post-Spinstr425 + sites-01):**
- `useProperties(clientId)` → `GET /workspaces/:id/business-data?type=PROPERTY`
- `useDataItem(id)` → single fetch
- `useListingUrlImport(clientId)` → `POST /workspaces/:id/listings/url` (analyze; returns extracted fields + photos + quality grade)
- `useListingUrlConfirm(clientId)` → `POST /workspaces/:id/listings/url/confirm` (save; runs intake dedup)
- `useManualListingImport(clientId)` → `POST /workspaces/:id/listings/manual` (manual create)
- `useUploadAsset(clientId)` → `POST /workspaces/:id/assets/upload` (Cloudinary-backed via `services/storage/imageStorage.js`)

**`dataJson` canonical photo shape (sites-01):**

| Field | Type | Role |
|---|---|---|
| `imageUrl` | `string \| null` | Primary photo URL — back-compat with all existing readers (PropertyCard, Autopilot, Sites blocks). |
| `images` | `string[]` | All photo URLs in order. Still back-compat. |
| `_photos` | `Array<{ url, source: 'upload'\|'external_url'\|'import'\|'media_library', publicId?, alt?, isPrimary? }>` | Richer metadata. New readers should prefer the entry with `isPrimary === true`. |

**Read precedence** (`PropertyCard`, future Sites media picker):
1. `_photos[isPrimary].url`
2. `imageUrl`
3. `images[0]`
4. placeholder

Other property fields unchanged: address parts (`address`/`city`/`state`/`zip`), `price`, `bedrooms`/`bathrooms`/`sqft`, `propertyType`, `yearBuilt`, `listingUrl`, `externalListingId`/`mlsId`. Server-managed: `_events[]`, `_priceHistory[]`, `_statusHistory[]`.

**Upload path:** Browser → `POST /workspaces/:id/assets/upload` (raw bytes, MIME-sniffed) → `services/storage/imageStorage.js` → Cloudinary `upload_stream` (signed, server-side). Response is a `MediaAsset` row with `url` + `publicId`. The property modal does NOT link uploaded MediaAsset rows to the property today — that's a follow-up (no MediaAsset→property FK exists yet).

### 2.10 Tests baseline (2026-05-18)

- API: **942/942 passing** (one sites test: `tests/sitesService.test.js` covers slug extraction, IP hashing, honeypot, form validation).
- Web: **306/306 passing**, typecheck clean. **No dedicated sites tests in the web repo** — editor logic is integration / manual QA today.
- Public renderer: no tests.

---

## 3. Proposed Phased Plan

Each phase ships independently, leaves the system in a coherent
state, and can be reverted without dragging later phases backwards.

### Phase 1 — Source metadata + property page basics — ✅ SHIPPED (sites-02)

Goal: when a SitePage has `sourceType: PROPERTY`, the editor knows
which property and the renderer/editor surface autofill primitives.

**Implementation:**

- **Property normalizer** (`squadpitch-web/src/lib/property/normalize.ts`) — pure helper turning a `WorkspaceDataItem` of type=PROPERTY into a predictable shape (title, address parts, price, beds/baths/sqft, propertyType, yearBuilt, description, primaryImage, images, listingUrl, status, externalListingId). Read precedence preserved (`_photos[isPrimary] > imageUrl > images[0]`). 17 unit tests pin every back-compat path.
- **Editor source panel** — when `page.sourceType === 'PROPERTY'` + `sourceId`, `PageEditor` fetches via `useDataItem` and renders `PropertySourcePanel`: thumbnail, address, status pill, price, beds/baths/sqft/type, link to Properties tab. Missing source → non-blocking yellow warning ("Linked property not found. Existing page content is safe.").
- **"Pull from property" actions** — explicit one-shot autofill buttons on `hero` (headline + subheadline + imageUrl), `paragraph` (body via `buildSafeDescription` — never invents facts), `gallery` (imageUrls), `key_details` (items). Re-clicking overwrites. Buttons only render when a property source is resolved.
- **API deterministic fields** (`sites.generation.service.js → applyPropertyDeterministicFields`) — after the LLM emits a normalized page, rewrites the structured fields from property data: `hero.imageUrl`, `key_details.items`, `gallery.imageUrls`, `image.imageUrl` (only when missing), and `title + slug` from address (only when the LLM left a placeholder). LLM-written narrative copy (headlines, subheadlines, paragraph bodies) is preserved. Idempotent — applying twice is a noop. 13 API tests cover every block + edge case.

**Compatibility:** pages without `sourceType` continue to edit normally (panel + buttons don't render). Existing PUBLISHED pages untouched — generation changes only affect new `POST /site/pages/from-source` calls. `IDEA` + `CAMPAIGN` + `DATA_ITEM` source paths unchanged; only PROPERTY gets the deterministic overlay.

**Files changed (sites-02):**
- web: `src/lib/property/normalize.ts` + `.test.ts`, `src/app/(app)/workspaces/[clientId]/sites/_components/PageEditor.tsx`
- api: `domains/sites/sites.generation.service.js`, `tests/sitesPropertyDeterministic.test.js`

**Phase 1 limitations / follow-ups:**
- No automatic re-pull when the source property changes — autofill is one-shot. "Always sync" toggle is a Phase 4 idea.
- `applyPropertyDeterministicFields` doesn't *add* a gallery block when the LLM didn't include one. Phase 4 templates address that via per-(sourceType, pageGoal) scaffolds.

### Phase 2 — Media picker + property photos — ✅ SHIPPED (sites-03)

Goal: kill the URL-only image fields.

**Implementation:**

- **`MediaPickerModal`** (`components/studio/MediaPickerModal.tsx`) — new reusable modal with 4 tabs:
  - **Library** — workspace MediaAssets (always present; uses `useAssets` filtered to `assetType=image, status=READY`).
  - **Property Photos** — only appears when the editor passes `propertyImages` (i.e. on PROPERTY-linked pages). Default-active tab when populated.
  - **Upload** — file picker → `useUploadAsset` → server-side Cloudinary upload (signed; no secret on the client). JPG/PNG/WebP.
  - **URL** — paste an external image URL (fallback).
  - Returns `{ url, imageId?, publicId?, alt?, source: 'media_library' | 'property_photo' | 'upload' | 'external_url' }`. Supports `mode: 'single' | 'multi'` — single dispatches on click, multi accumulates and dispatches on "Add N images".
  - Decided NOT to extract `MiniMediaPicker` from `AddDataItemModal` — it was a thin inline grid (~50 lines) without tabs, upload, or URL paste. Kept it in place for the existing Add Data Item modal; built a fresh full-featured picker.

- **`ImageField`** (`sites/_components/ImageField.tsx`) — single-image picker for hero / image / testimonial blocks. Renders `[Thumbnail] [Choose…/Replace…] [Remove]` + a URL-paste fallback input. Calls `MediaPickerModal` in single mode. Always writes `imageUrl`; persists `imageId` when the picker returns one.

- **`GalleryField`** (`sites/_components/GalleryField.tsx`) — multi-image picker for the gallery block. Grid of thumbnails + "Add images" button. Dedups against the existing `imageUrls`. Calls `MediaPickerModal` in multi mode.

- **Wired into `PageEditor` `BlockFields`** for: hero, image, gallery, testimonial. Plain `<input type="text">` URL fields gone. The "Pull from property" actions added in Phase 1 still render alongside.

**imageId strategy (chosen):** write both `imageUrl` (always) and `imageId` (optional, when picker returns a Library / Upload asset). The public renderer **continues to read only `imageUrl`** — zero risk to existing pages. `imageId` is persisted as forward-looking metadata for a future signed-URL flow (private media buckets etc.), but the renderer doesn't depend on it today. The `imageId` column on hero + image blocks (declared but unused historically) is now populated when applicable.

**Renderer compatibility:**
- Old pages with only `imageUrl` → unchanged, render as before.
- New pages picked via Library → `imageUrl` set to the resolved Cloudinary URL + `imageId` set to the MediaAsset id.
- New pages with URL paste → `imageUrl` set, `imageId` null.
- The `lib/pageBlocks` dispatcher's "unknown field → skip" behavior already covered the new `imageId` field even before this change.

**Property photos integration:** when `page.sourceType === 'PROPERTY'`, `PageEditor` reads `property.images` (via the Phase 1 normalizer) and passes them as `propertyImages` to every ImageField + GalleryField. The Property Photos tab in the modal pulls from that list. "Use all property photos" is implemented via the **Phase 1 "Pull from property" button** on the gallery block (kept separate so the user can either pull-all or hand-pick).

**Files changed (sites-03):**
- `components/studio/MediaPickerModal.tsx` (new)
- `sites/_components/ImageField.tsx` (new)
- `sites/_components/GalleryField.tsx` (new)
- `sites/_components/PageEditor.tsx` — `BlockFields` updated; `clientId` threaded through `SortableBlockCard` so the picker can fetch assets.

**Phase 2 limitations / follow-ups:**
- No drag-drop on the upload tab — file input click only (consistent with sites-01).
- `MediaAsset` rows aren't auto-tagged "site_page" — uploads land in the workspace library un-folder. A future enhancement could pass a `folderId` per Sites context.
- Public renderer's `imageId` resolution is **deferred**: the resolver doesn't yet return a `resolvedImageUrl` for `imageId`-only blocks. Since we always write `imageUrl` alongside, this isn't blocking — flagged for when a private-asset flow is needed.
- `MediaPickerModal` doesn't paginate — `useAssets` page is capped at the default (50–100). Workspaces with thousands of images would need a future search/pagination layer.

Risk: Medium → executed Low. Touches the editor but **not** the public renderer (read path unchanged). Existing pages keep rendering.

### Phase 3 — Draft preview — ✅ SHIPPED (sites-04)

Goal: editors see their unsaved changes before clicking Publish.

**Chosen approach: Option A (in-app authenticated preview).** No
new API endpoint, no preview token. The editor renders the local
unsaved blocks in a mirrored block renderer right inside the
authenticated dashboard route. Safer than a token-based public
preview, simpler to ship, and zero risk to the public site.

**Implementation:**

- **`PreviewRenderer`** (`sites/_components/PreviewRenderer.tsx`) — mirrors `squadpitch-sites/lib/pageBlocks/index.tsx` 1:1: same block dispatcher, same per-block components, same inline styles. Every user-authored string still passes through React's JSX escaping; every URL still gates on the `^https?://` scheme check before becoming a background-image or `src`. `lead_form` blocks render as a labeled placeholder card ("Lead form will appear here") — preview is for layout review, not lead capture. Links (`cta`, `contact.tel:`, `contact.mailto:`) have their default action stopped via `onClick={e => e.preventDefault()}` so accidental clicks inside the preview don't navigate away.
- **Edit / Preview toggle** in the editor top bar (next to Save draft / Publish). State is local — toggling Preview shows the rendered view; toggling back to Edit returns to the block list with all unsaved edits intact.
- **Desktop / Mobile viewport toggle** above the preview (1080px / 390px frame widths). The preview card uses the public site's dark background + same color tokens so it visually matches the live URL.
- **"Draft preview" badge** above the viewport so the user always knows this isn't the live URL.
- **Save/Publish copy** below the action row tells the truth about what those buttons do:
  - DRAFT: *"Drafts are private until you publish. Use Preview to see what the page will look like."*
  - PUBLISHED: *"This page is published. Saving changes updates the working page and may appear live after the site refreshes."*
- **View Live** button only appears when the page is published (existing behavior, codified with a `data-testid`).
- **Preview URL hint** (the existing footer note about the post-publish URL) hides during preview mode to reduce noise.

**Why we did NOT build a token-based public preview route:**
The shared blocksJson model means the public renderer already shows the latest save once ISR revalidates. A public-preview-with-token would add new auth surface and a duplicate rendering path for marginal upside (parity with the live URL beyond what the mirrored renderer already provides). If a future case demands true parity (e.g. ad-platform crawler validation against a draft), we'll revisit.

**Files changed (sites-04):**
- `sites/_components/PreviewRenderer.tsx` (new)
- `sites/_components/PageEditor.tsx` — Edit/Preview toggle, Desktop/Mobile viewport, status notes, `PreviewViewport` helper.

**Save/publish mental model (documented in-product):**
- Saving a DRAFT updates the working page; it stays unreachable until you Publish.
- Saving a PUBLISHED page updates the working copy and the live URL — there's no separate "next published version" buffer. ISR caches mean the change is visible after the site revalidates.
- This is intentionally truthful — we did NOT add a draft-vs-published split here. A real split (`draftBlocksJson` + `publishedBlocksJson`) is documented as deferred under §9 "out of scope for now"; the current model has no schema-level discard mechanism for edits made against a published page.

**Phase 3 limitations / follow-ups:**
- The preview-mode page editor doesn't auto-refresh on background saves (no save events to listen to inside the editor — local state is the source of truth in this mode).
- Lead-form preview is a placeholder, not the real form. Real form-render preview would either need a form-fields fetch inside the preview or a duplication of `LeadFormBlock`.
- Renderer parity is by visual review — there's no automated diff between `PreviewRenderer` and `squadpitch-sites/lib/pageBlocks/index.tsx`. Drift between the two would be a Phase 6 hardening concern; shared-package extraction is the long-term answer if drift becomes painful.

### Phase 4 — Real-estate templates + AI generation upgrade — ✅ SHIPPED (sites-05)

Goal: pick a template + (for property templates) a property → get a structured page in seconds, not a free-form LLM blob.

**Templates shipped:**

| Key | Goal | Block scaffold (in order) | Notes |
|---|---|---|---|
| `property_listing` | LISTING | hero → key_details → gallery → paragraph → cta → lead_form → contact | Property-linked. Photos + facts deterministic. |
| `open_house` | EVENT | hero → key_details → gallery → paragraph → cta → lead_form → contact | Property-linked. Surfaces `open_house` event date if present. |
| `just_sold` | LEAD_CAPTURE | hero → paragraph → gallery → cta → lead_form → contact | Property-linked. Prompt forbids quoting sale price unless explicit in data. |
| `seller_lead` | LEAD_CAPTURE | hero → paragraph → key_details → faq → cta → lead_form → contact | IDEA source — value-prop + FAQ. |
| `buyer_lead` | LEAD_CAPTURE | hero → paragraph → faq → cta → lead_form → contact | IDEA source — value-prop + FAQ. |
| `neighborhood_guide` | LEAD_CAPTURE | hero → paragraph → key_details → cta → lead_form → contact | Prompt forbids fabricating amenities/schools/walkability. |

**Architecture:**

- `GeneratePageSchema` adds optional `template: SiteTemplateEnum` (validated against the six keys).
- `generatePageFromSource()` threads `template` into both `buildSystemPrompt` and `buildUserPrompt` so the LLM gets the template label + block-order hint + intent string.
- New `applyTemplateScaffold(payload, template)` pass runs between normalization and the existing `applyPropertyDeterministicFields`. It **only appends** missing required block types — never reorders or removes blocks the LLM produced. Each appended block is an empty placeholder (`{ type, …safe defaults }`) the downstream deterministic fill then populates. `lead_form` gets `formId: '__PENDING__'` so the existing route step that auto-creates a form + resolves the placeholder still works. `testimonial` is never auto-appended — no fabricated quotes.
- Response now includes `templateUsed` so the audit trail / UI can show what scaffold was applied.

**Grounding rules (system prompt addition):**

The LLM is now explicitly told it MUST NOT fabricate:
- market statistics (median price, days on market, inventory)
- school ratings, districts, or names
- walkability or transit scores
- specific neighborhood amenities not in the provided data
- exact sale prices for sold listings unless they appear in the data
- financing terms, mortgage rates, down-payment specifics

The rule is *"Only state these facts if they appear verbatim in the supplied source data. If unsure, omit the fact rather than guess."* Replaces the earlier loose "Don't fabricate facts about specific properties."

**Web wizard restructure:**

- New Step 1: **Template** — grid of seven cards (6 templates + Custom).
- Property templates auto-set `sourceType = PROPERTY` + the template's pageGoal, then go straight to property pick on Step 2.
- IDEA templates (seller_lead, buyer_lead, neighborhood_guide) auto-set `sourceType = IDEA` + LEAD_CAPTURE and go to the idea-prompt on Step 2.
- Custom keeps the original 3-step flow (source type → source → goal) for full flexibility.
- For pre-canned templates the goal step is skipped — clicking Continue on step 2 generates directly. The step indicator collapses to 2 steps when a template is selected.

**Backwards compatibility:** omitting `template` from the API call preserves the exact pre-sites-05 behavior (no scaffold pass, looser prompt). Existing IDEA / CAMPAIGN / DATA_ITEM paths through Custom work unchanged. `applyPropertyDeterministicFields` (sites-02) runs after the new scaffold pass — order matters and is idempotent.

**Files changed (sites-05):**
- api: `domains/sites/sites.generation.service.js`, `domains/sites/sites.schemas.js`, `tests/sitesTemplateScaffolds.test.js`
- web: `src/hooks/useSites.ts`, `src/app/(app)/workspaces/[clientId]/sites/_components/SiteCreateWizard.tsx`

**Phase 4 limitations / follow-ups:**

- The wizard doesn't display a per-template preview before pick — Phase 6 polish.
- `open_house` doesn't yet surface the open-house date directly in the hero — `applyPropertyDeterministicFields` could be extended to pull from `dataJson.events`. Left as follow-up.
- `templateUsed` is returned but the editor doesn't show it as a source-panel badge yet — small UI polish.

### Phase 5 — Block UX + form integration — ✅ SHIPPED (sites-06)

Goal: editor feels like a builder, not a JSON form, and lead-form blocks carry source context all the way to the submission row.

**Block UX (web):**

- Each `SortableBlockCard` now has a proper header:
  - User-friendly label (`Hero`, `Property Details`, `Photo Gallery`, `Lead Capture Form`, `Agent Contact`, `Testimonial`, `FAQ`, `Call to action`, `Paragraph / Story`, `Image`) via the new `BLOCK_LABELS` map.
  - Collapse / expand toggle (chevron + label is the toggle).
  - **Move up** / **Move down** buttons alongside the existing drag handle.
  - **Duplicate block** button (`structuredClone` of the block, inserted after the source).
  - Existing Remove button preserved.
  - Drag handle (dnd-kit) preserved — keyboard reorder still works.
- **Add Block** flow restructured as `BlockPicker` with categories:
  - *Headline & copy* (hero, paragraph, image)
  - *Property info* (key_details, gallery)
  - *Trust & objections* (testimonial, faq)
  - *Conversion* (cta, lead_form, contact)
  - **Suggested for property pages** group renders ahead of categories when the page has a PROPERTY source — picks from `PROPERTY_SUGGESTED`.
- Closing the picker after add is automatic (good UX, no extra click).

**Lead Form block enrichment (web):**

When a `lead_form` block has a `formId` set, the editor renders a context card below the form picker:
- Form name (bold)
- Field count + notify-email summary
- **Edit form →** link (deep-links to `/sites?tab=forms&formId=…`)
- **View submissions** link (deep-links to `/sites?tab=submissions&formId=…`)

When no form is selected, the block shows a helpful prompt instead of being silent. When the workspace has zero forms, a "Create one first" link routes to the forms tab.

**Submission context (api + sites):**

- The public submit endpoint already accepts `pageId` + `campaignId` in the body (pre-sites-06 audit confirmed this). The renderer side was the gap.
- `BlocksRenderer` (squadpitch-sites) now threads an optional `pageId` prop down to `LeadFormBlock` → `LeadFormClient`, which already serialized `pageId` into the submit payload. `app/[campaign]/page.tsx` passes `payload.page.id`. Old callers / older deployments that omit `pageId` still work.
- **Tenant-scoping defense** added to `createFormSubmission`: `pageId` and `campaignId` are validated against `form.clientId` before write. A spoofed cross-tenant id is silently nulled (don't reject — bots / older renderers shouldn't fail). Implementation: `scopedPageId(pageId, clientId)` + `scopedCampaignId(campaignId, clientId)` look up the row and only persist the id if it belongs to the form's workspace.
- Result: every form submission from a Sites page now records which page generated the lead, with no cross-tenant leakage risk.

**Files changed (sites-06):**
- api: `domains/sites/sites.service.js`, `tests/sitesPublicSubmitScoping.test.js`
- web: `src/app/(app)/workspaces/[clientId]/sites/_components/PageEditor.tsx`
- sites: `lib/pageBlocks/index.tsx`, `lib/pageBlocks/LeadFormBlock.tsx`, `app/[campaign]/page.tsx`

**Phase 5 limitations / follow-ups:**

- **Submissions list filter by `pageId`** is NOT yet exposed via API/UI — the column exists on `FormSubmission` and the deep-link in the lead-form block points at a `?formId=` query param the submissions tab can use. A `?pageId=` filter on the list endpoint is a small additive change, deferred to Phase 6.
- **"Create new form inline"** in the lead-form block is NOT yet wired — the existing forms-tab flow handles creation. Inline create would need a small modal in the editor; deferred.
- **Submissions count + last-submission date** on the lead-form block panel — would need a per-form `useFormStats` hook. Deferred.
- **`inquiryAboutPropertyId` / `inquiryAboutPropertyTitle`** custom submission columns from the prompt — not added. The page's `sourceType` + `sourceId` already encode this on `SitePage`, and a submission's `pageId` deep-links to that. Derived/queried rather than denormalized.
- **Per-template form CTA suggestions** (e.g. "Request a showing" for property listing) — the AI generation prompt already biases CTA text by template (Phase 4), but the editor doesn't yet suggest these CTAs when the user manually creates a form. Deferred.

Risk: executed Low. The lead-form-block context card is pure additive UI. The tenant-scoping change is purely defensive — pre-sites-06 the endpoint already wrote whatever client supplied, so this fix tightens security without breaking any existing behavior.

### Phase 6 — Final hardening — ✅ SHIPPED (sites-07)

Goal: shipping bar for "data-aware sites" as a feature.

**Public renderer test harness — the big one.** squadpitch-sites
had zero tests before this phase. Added:

- `vitest` to the sites repo `devDependencies` + `npm test` /
  `npm run test:watch` scripts.
- `lib/pageBlocks/safety.ts` (new) — pure helpers extracted
  from the dispatcher: `KNOWN_BLOCK_TYPES`,
  `isKnownBlockType`, `isSafeUrl`, `pickString`, `pickArray`,
  `shouldRenderBlock`, `filterRenderableBlocks`.
- `lib/pageBlocks/safety.test.ts` (new, **43 tests**) pinning
  the dispatcher's safety contract:
  - URL scheme gate (blocks `javascript:` / `data:` /
    `vbscript:` / `file:` / `ftp:` / protocol-relative)
  - Forward-compat: unknown block types silently skipped
  - Block-level integration: malformed entries dropped (not
    the whole page)
  - Published-page back-compat scenarios: legacy hero with
    only `imageUrl`, gallery with mixed safe/unsafe URLs,
    `key_details` with mixed-type rows

**Documentation:**
- New `docs/SITES_EDITOR_MVP_IMPLEMENTATION.md` — full
  reference doc (models, endpoints, block catalog, AI
  generation flow, security model, known limitations,
  back-compat confirmation). Mirrors the
  `AUTOPILOT_MVP_IMPLEMENTATION.md` shape.
- This plan doc updated with the Phase 6 completion note.

**Deferred from Phase 6 (documented in MVP doc §12):**
- Wire `revalidateSec` through to the renderer's
  `export const revalidate = …` — flagged as a small future
  enhancement; not blocking since the catch-all already
  refreshes on next request after invalidation.
- Playwright end-to-end (publish → resolve → render) —
  out of scope for the test infra bootstrap; vitest unit
  coverage on the safety contract is the high-leverage
  layer.
- Autopilot "View in Sites" CTA from a property-page rec —
  natural product follow-up but outside the Sites scope.

**Files changed (sites-07):**
- sites: `lib/pageBlocks/safety.ts` (new),
  `lib/pageBlocks/safety.test.ts` (new),
  `package.json` (vitest devDep + test scripts).
- api: `docs/SITES_EDITOR_MVP_IMPLEMENTATION.md` (new),
  `docs/SITES_EDITOR_UPGRADE_PLAN.md` (this section).

**Phase 6 result — final tests baseline:**
- API: **984/984 passing** (8 sites-specific files)
- Web: **340/340 passing**, typecheck clean
- Sites: **43/43 passing**, typecheck clean

Risk: executed Low. Pure additive test infra + docs. No
behavior changes.

---

## 4. Risks identified

1. **Public renderer is untested.** Phase 2 touches the read path; adding a test harness ahead of time is prudent.
2. **Single-column `blocksJson`** means "save" = "show on next ISR pull." Phase 3 (preview) materially changes the editor mental model; communicate this in the UI.
3. **`imageId` is a declared-but-unused column.** Phase 2 promotes it to a first-class field; need to make sure the API resolver returns a usable URL per id (signed if assets bucket is private).
4. **AI generation is the only path that touches `sourceContext`.** The current `from-source` service expects an LLM call. Phase 4 introduces a deterministic-template path; should still be callable from the wizard with no UX regression.
5. **Per-workspace single Site** (Site.clientId is unique). Future multi-site (e.g., per-listing micro-sites) is not in scope; flagged so we don't accidentally rely on the constraint.
6. **No `BlockType` enum in Prisma.** Block kinds are TypeScript-only. Adding a new block type means: web type def + API generation schema + public renderer dispatch. Document this clearly in Phase 6.
7. **`PageEditor.tsx` is ~1000 lines.** Phases 1 + 5 will tempt incidental cleanup; resist refactor-with-feature unless the test coverage lands first.

---

## 5. Recommended next prompt

Phase 1 (`02_page_source_metadata_and_property_pages.txt`). It's the
smallest change with the biggest leverage: makes every later phase
easier because the editor + AI service already share an understanding
of "this page is about this property."

---

## 6. Files inspected

**squadpitch-api**
- `prisma/schema.prisma` (Site, SitePage, LeadForm, FormSubmission, enums)
- `domains/sites/sites.dashboard.routes.js`
- `domains/sites/sites.dashboard.service.js`
- `domains/sites/sites.generation.service.js`
- `domains/sites/public.routes.js`
- `tests/sitesService.test.js`

**squadpitch-web**
- `src/hooks/useSites.ts` (Block union, page/list types, all mutations)
- `src/app/(app)/workspaces/[clientId]/sites/page.tsx` (list)
- `src/app/(app)/workspaces/[clientId]/sites/_components/PageEditor.tsx`
- `src/app/(app)/workspaces/[clientId]/sites/_components/SiteCreateWizard.tsx`
- `src/components/studio/AddDataItemModal.tsx` (existing `MiniMediaPicker`)
- `src/hooks/useSquadpitch.ts` (`useAssets`, `useProperties`, `useDataItem`, `useUploadAsset`)

**squadpitch-sites**
- `app/[campaign]/page.tsx`
- `app/page.tsx`
- `lib/pageBlocks/index.tsx`
- `lib/api.ts`

---

## 7. Tests run for this audit

- `squadpitch-api`: `npx vitest run` → **942/942 passing**
- `squadpitch-web`: `npx vitest run` → **306/306 passing**
- `squadpitch-web`: `npx tsc --noEmit` → clean

No code changes; baseline confirmed before Phase 1.

---

## 8. Architecture summary (one paragraph)

Sites is already well-structured: a thin REST surface over a small
set of Prisma models, with source-attribution columns already on
`SitePage` and a clean public renderer that's forward-compatible
with unknown block types. The product gap isn't architectural —
it's that the editor's image fields are URL-only, blocks don't pull
from the source object that the column claims they came from, and
the AI generator emits free-form copy instead of using the
property's structured `dataJson`. Phases 1–5 close those three gaps
in order, each independently shippable. Phase 6 hardens the result.

No mandatory migration. No breakage of existing pages. No deletion
of page data. The plan respects every guardrail in the prompt.
