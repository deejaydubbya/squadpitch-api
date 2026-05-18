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

### Phase 2 — Media picker + property photos

Goal: kill the URL-only image fields.

- Extract `MiniMediaPicker` from `AddDataItemModal.tsx` into a reusable `MediaPickerModal` that opens from the editor.
- New block field affordance: image inputs render as `[Thumbnail] [Choose…] [Replace] [Remove]`. Choose opens the picker with a tab for **Library** (workspace assets) and **Property photos** (when `page.sourceType === 'PROPERTY'`, pulls `dataJson.images[]`).
- Wire `imageId` to actually persist when the picker is used. The renderer should accept either `imageId` (preferred, signed URL resolved by the API resolver) or `imageUrl` (back-compat).
- Public renderer (`squadpitch-sites`): API resolver returns a resolved image URL per `imageId`; renderer prefers `imageUrl` for back-compat and falls back to resolved URL. Old pages keep working.

Risk: Medium. Touches the public renderer (read path). Worth a dedicated test sweep — the existing block dispatcher's "unknown block / unknown field → skip" behavior is the safety net.

### Phase 3 — Draft preview

Goal: editors see their unsaved changes before clicking Publish.

- Add a **preview** endpoint on the API: `GET /workspaces/:id/site/pages/:pageId/preview?token=…` — returns the page exactly like the public resolver but with the workspace owner's auth (token issued by the editor on demand, scoped to the page, ~10 min TTL). Renders DRAFT blocks regardless of publish status.
- Editor opens this URL in an iframe panel (toggleable side-by-side / full).
- Auto-refresh the iframe on save.
- No change to public renderer; preview reuses the same block dispatcher but with explicit "PREVIEW" badge in the layout.

Risk: Medium. The new auth path needs the same `requireClientOwner` discipline.

### Phase 4 — Real-estate templates + AI generation upgrade

Goal: pick "Property" + a property → get a structured property page in seconds, not a free-form LLM blob.

- API: add a templates layer that selects a block scaffold by `(sourceType, pageGoal)`. For `(PROPERTY, LISTING)`: `[hero(image,address), key_details(beds/baths/sqft/price/year), gallery(images), paragraph(description), lead_form, contact]`. For `(PROPERTY, OPEN_HOUSE)`: add a heading block with date/time + gallery.
- LLM is responsible for the **copy inside the scaffold** (hero subheadline, paragraph body). Structured fields (price, beds/baths, gallery) are deterministically populated from `dataJson` — no hallucination risk.
- Surfacing: `useGeneratePageFromSource` returns a generated `templateUsed` for the audit trail.
- Forms: `from-source` already auto-creates the LeadForm; extend to attach `pageId` to the form so submissions carry context.

Risk: Medium. The generation service is in active use; behavior change must keep the existing "IDEA" path working.

### Phase 5 — Block UX + form integration

Goal: editor feels like a builder, not a JSON form.

- Inline previews on `hero` / `image` / `gallery` block cards.
- Reorder via drag handles (dnd-kit already there — tighten the affordance).
- Forms: per-page LeadForm picker in the `lead_form` block field. "Create new form" inline. Show submission count + last submission date next to the block.
- Submissions view: filter by `pageId` so the user can drill from a page → its submissions.

Risk: Low. Pure FE work + an additive query param on the submissions endpoint.

### Phase 6 — Final hardening

Goal: shipping bar for "data-aware sites" as a feature.

- Wire `revalidateSec` through to the renderer's `export const revalidate = …`.
- Public-renderer integration tests (currently zero).
- Editor smoke tests via component-level helpers + a Playwright happy-path (publish → resolve → render).
- Update `docs/AUTOPILOT_MVP_IMPLEMENTATION.md` to reflect the new property → page flow (Autopilot's "View in Sites" CTA from a property-page rec is a natural follow-up).
- Documentation pass: `SITES_EDITOR_UPGRADE_PLAN.md` (this doc) gets a completion note + lessons learned per phase.

Risk: Low-medium. Mostly test infra.

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
