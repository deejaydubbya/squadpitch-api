// Sites service — the read paths used by the public runtime.
//
// resolvePublicPage() is the locked-down lookup the
// /api/v1/public/sites/resolve endpoint hits. It returns
// PUBLISHED-only data and strictly bounds the response shape so
// nothing private about the workspace leaks (no createdBy, no
// timezone, no draft posts, no settings).
//
// formatPublicPage() / formatPublicForm() etc. live here so the
// "what's safe to return publicly" contract is in one place.

import { prisma } from "../../prisma.js";
import { intakeFormSubmission } from "../inbox/inbox.intake.service.js";

// Strip any port + scheme off the host so we work with a bare
// hostname. Returns null on shapes we don't trust.
function normalizeHost(host) {
  if (typeof host !== "string" || host.length === 0) return null;
  const hostname = host.split(":")[0].toLowerCase().trim();
  // Defensive — reject anything with whitespace or path-like
  // characters. Real hostnames are dotted alphanumerics + dashes.
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(hostname)) return null;
  return hostname;
}

function getBaseDomain() {
  return (process.env.PUBLIC_SITES_BASE_DOMAIN || "squadpitchsites.com").toLowerCase();
}

/**
 * Public-facing base domain for [client].squadpitchsites.com URLs.
 * Exported so other domains (e.g. ads exports) can render real
 * URLs that match the public runtime's routing.
 */
export function getPublicSitesBaseDomain() {
  return getBaseDomain();
}

/**
 * Compose a public SquadSites page URL from a client slug + page
 * slug. Returns null when either piece is missing; callers should
 * surface a useful error rather than emit a partial URL.
 */
export function buildPublicSitePageUrl({ clientSlug, pageSlug } = {}) {
  if (typeof clientSlug !== "string" || clientSlug.trim().length === 0) return null;
  if (typeof pageSlug !== "string" || pageSlug.trim().length === 0) return null;
  const cleanClient = clientSlug.trim().toLowerCase();
  const cleanPage = pageSlug.trim().replace(/^\/+/, "");
  return `https://${cleanClient}.${getBaseDomain()}/${cleanPage}`;
}

/**
 * Extract the client slug from a `[client].squadpitchsites.com`
 * hostname. Custom-domain resolution (Phase E) would also live
 * here, looking up a Domain table — for now we only support the
 * wildcard subdomain shape.
 */
export function extractClientSlugFromHost(host) {
  const hostname = normalizeHost(host);
  if (!hostname) return null;
  const baseDomain = getBaseDomain();
  if (hostname === baseDomain) return null;             // apex — no slug
  const suffix = `.${baseDomain}`;
  if (!hostname.endsWith(suffix)) return null;          // not our domain
  const sub = hostname.slice(0, hostname.length - suffix.length);
  if (!sub || sub.includes(".")) return null;            // no nested subs
  return sub;
}

/**
 * Parse the URL path the runtime forwarded into a page slug.
 * Returns null when the path is empty / unrecognized so the
 * caller can 404.
 */
export function extractPageSlugFromPath(path) {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return null;          // apex page handled in a later phase
  // Strip leading slash; reject any path with sub-segments for
  // now — `[campaign]` is one segment.
  const stripped = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  if (stripped.includes("/")) return null;
  // Sanity-check the slug shape so we don't pass arbitrary input
  // into the Prisma query as a literal match.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,127}[a-z0-9])?$/.test(stripped)) return null;
  return stripped;
}

/**
 * Public-runtime page resolution. Inputs come straight off the
 * request; the function does its own validation + bounds.
 *
 * Returns:
 *   - null when we should 404 (no client, no page, or page not
 *     PUBLISHED)
 *   - { site, page, campaign?, forms[] } payload otherwise
 */
export async function resolvePublicPage({ host, path }) {
  const clientSlug = extractClientSlugFromHost(host);
  if (!clientSlug) return null;
  const pageSlug = extractPageSlugFromPath(path);
  if (!pageSlug) return null;

  // Resolve client → site → page in one chain. clientId is
  // denormalized on site_pages so the page lookup is a single
  // indexed read once we have the clientId.
  const client = await prisma.client.findUnique({
    where: { slug: clientSlug },
    select: { id: true, status: true },
  });
  if (!client) return null;
  if (client.status === "ARCHIVED" || client.status === "PAUSED") return null;

  // Site must be PUBLISHED for any page on it to be reachable.
  const site = await prisma.site.findUnique({
    where: { clientId: client.id },
    select: {
      id: true,
      status: true,
      themeJson: true,
      faviconUrl: true,
      ogDefaultImageId: true,
    },
  });
  if (!site || site.status !== "PUBLISHED") return null;

  const page = await prisma.sitePage.findUnique({
    where: { clientId_slug: { clientId: client.id, slug: pageSlug } },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      status: true,
      blocksJson: true,
      heroImageId: true,
      seoTitle: true,
      seoDescription: true,
      ogImageId: true,
      revalidateSec: true,
      noIndex: true,
      publishedAt: true,
      campaignId: true,
      // Intentionally NOT selecting sourceType / sourceId / pageGoal
      // — those are workspace-internal metadata. The public payload
      // should only carry rendering + SEO flags.
    },
  });
  if (!page || page.status !== "PUBLISHED") return null;

  // Lazy-load referenced forms. Block types that reference a
  // formId (e.g. lead_form blocks) need the form's fieldsJson +
  // successAction so the runtime can render the form
  // server-side without an extra round trip.
  const formIds = collectFormIds(page.blocksJson);
  const forms = formIds.length > 0
    ? await prisma.leadForm.findMany({
        where: { id: { in: formIds }, clientId: client.id },
        select: {
          id: true,
          name: true,
          fieldsJson: true,
          successAction: true,
        },
      })
    : [];

  // Optional Campaign metadata for SEO/links. We don't return
  // the full campaign object — just the bits that are safe to
  // surface publicly.
  let campaign = null;
  if (page.campaignId) {
    const c = await prisma.campaign.findUnique({
      where: { id: page.campaignId },
      select: { id: true, name: true, campaignType: true },
    });
    if (c) campaign = c;
  }

  return {
    site: {
      id: site.id,
      themeJson: site.themeJson,
      faviconUrl: site.faviconUrl,
    },
    page: {
      id: page.id,
      slug: page.slug,
      title: page.title,
      description: page.description,
      blocksJson: page.blocksJson,
      revalidateSec: page.revalidateSec,
      noIndex: page.noIndex,
      publishedAt: page.publishedAt,
      seo: {
        title: page.seoTitle,
        description: page.seoDescription,
        ogImageId: page.ogImageId,
        heroImageId: page.heroImageId,
      },
    },
    campaign,
    forms: forms.map(formatPublicForm),
  };
}

function formatPublicForm(form) {
  return {
    id: form.id,
    name: form.name,
    fieldsJson: form.fieldsJson,
    successAction: form.successAction,
  };
}

/**
 * Walk a page's blocksJson and collect every formId referenced
 * by `lead_form` blocks. Tolerant of any block shape — we only
 * pull formId when it's a non-empty string.
 */
function collectFormIds(blocksJson) {
  if (!Array.isArray(blocksJson)) return [];
  const ids = new Set();
  for (const block of blocksJson) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "lead_form" && typeof block.formId === "string" && block.formId) {
      ids.add(block.formId);
    }
  }
  return Array.from(ids);
}

// ── Form submission intake ─────────────────────────────────────────

/**
 * Look up a LeadForm and its parent Site for an inbound form
 * submission. Returns null when the form doesn't exist or its
 * Site isn't PUBLISHED — caller treats either as 404.
 */
export async function getActiveFormForSubmission(formId) {
  if (typeof formId !== "string" || !formId) return null;
  const form = await prisma.leadForm.findUnique({
    where: { id: formId },
    include: {
      site: { select: { id: true, status: true, clientId: true } },
    },
  });
  if (!form) return null;
  if (form.site.status !== "PUBLISHED") return null;
  return form;
}

/**
 * Persist a FormSubmission row. Caller is responsible for
 * rate-limit + honeypot + field validation BEFORE calling this.
 * Stores the SHA-256 hash of the IP, never the raw IP.
 */
export async function createFormSubmission({
  form,
  fields,
  ipHash,
  userAgent,
  referer,
  pageId,
  campaignId,
}) {
  // Best-effort contact-field extraction so Inbox lookup
  // (later phase) doesn't need to parse dataJson.
  const fieldDefs = Array.isArray(form.fieldsJson) ? form.fieldsJson : [];
  const contactEmail = pickFieldValue(fieldDefs, fields, "email");
  const contactPhone = pickFieldValue(fieldDefs, fields, "phone");

  const submission = await prisma.formSubmission.create({
    data: {
      formId: form.id,
      clientId: form.clientId,
      pageId: pageId || null,
      campaignId: campaignId || null,
      dataJson: fields,
      contactEmail: contactEmail || null,
      contactPhone: contactPhone || null,
      ipHash: ipHash || null,
      // Truncate UA defensively — bots send absurdly long strings.
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 500) : null,
      referer: typeof referer === "string" ? referer.slice(0, 500) : null,
      status: "NEW",
    },
  });

  // Fire-and-forget Inbox intake. Intentionally NOT awaited so a
  // failing inbox-side path never blocks or fails the form submit
  // (the form-submit endpoint has its own 5/min IP rate limit, so
  // it's perf-sensitive). The intake service is idempotent on
  // submission.id, so the backfill script can pick up anything
  // that fails here.
  //
  // MVP keeps this inline; a future Redis-backed worker would
  // slot in by changing this single call to enqueue a job.
  intakeFormSubmission(submission).catch((err) => {
    // Full diagnostic — message + Prisma error code + stack — so
    // ops can root-cause why an intake threw. The user-facing form
    // submission already returned 200, but the Inbox surface won't
    // show this conversation; a silent failure here is invisible.
    console.error("[inbox.intake] FAILED — submission lost from Inbox surface:", {
      submissionId: submission.id,
      clientId: submission.clientId,
      formId: submission.formId,
      pageId: submission.pageId,
      contactEmail: submission.contactEmail,
      contactPhone: submission.contactPhone ? "<set>" : null, // don't log phone
      errorName: err?.name,
      errorMessage: err?.message,
      // Prisma errors carry .code (e.g. P2002 unique constraint).
      prismaCode: err?.code,
      prismaMeta: err?.meta,
      stack: err?.stack?.split("\n").slice(0, 8).join("\n"),
    });
  });

  return submission;
}

function pickFieldValue(fieldDefs, submittedFields, wantedType) {
  if (!submittedFields || typeof submittedFields !== "object") return null;
  for (const def of fieldDefs) {
    if (!def || typeof def !== "object") continue;
    if (def.type !== wantedType) continue;
    if (typeof def.key !== "string" || !def.key) continue;
    const value = submittedFields[def.key];
    if (typeof value === "string" && value.length > 0 && value.length < 320) {
      return value;
    }
  }
  return null;
}
