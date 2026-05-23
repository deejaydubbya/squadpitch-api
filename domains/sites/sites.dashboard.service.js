// Authenticated dashboard service for SquadSites.
//
// All functions in this file assume the caller has already verified
// workspace ownership (via requireClientOwner). Each helper takes an
// explicit clientId and scopes queries to it, so even if a route
// forgot the auth guard we wouldn't accidentally cross workspaces.
//
// The public read path lives in sites.service.js; this module is for
// the workspace-owner-facing CRUD.

import { prisma } from "../../prisma.js";
import { triggerRuntimeRevalidate } from "./revalidate.client.js";

// ── Site ────────────────────────────────────────────────────────────────

// Find the workspace's Site if it exists, otherwise auto-create a
// DRAFT row keyed to clientId. One site per workspace is enforced by
// the UNIQUE constraint on Site.clientId, so this is safe to call
// idempotently from any dashboard read.
export async function getOrCreateSite(clientId, createdBy) {
  const existing = await prisma.site.findUnique({ where: { clientId } });
  if (existing) return existing;
  return prisma.site.create({
    data: { clientId, createdBy, status: "DRAFT" },
  });
}

export async function updateSite(clientId, patch) {
  await getOrCreateSite(clientId, patch.createdBy || "");
  return prisma.site.update({
    where: { clientId },
    data: {
      status: patch.status,
      themeJson: patch.themeJson === undefined ? undefined : patch.themeJson,
      faviconUrl: patch.faviconUrl === undefined ? undefined : patch.faviconUrl,
      ogDefaultImageId:
        patch.ogDefaultImageId === undefined ? undefined : patch.ogDefaultImageId,
    },
  });
}

// ── SitePages ───────────────────────────────────────────────────────────

export async function listPages(clientId) {
  return prisma.sitePage.findMany({
    where: { clientId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      status: true,
      campaignId: true,
      sourceType: true,
      sourceId: true,
      pageGoal: true,
      noIndex: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getPage(clientId, pageId) {
  return prisma.sitePage.findFirst({
    where: { id: pageId, clientId },
  });
}

export async function createPage(clientId, createdBy, input) {
  const site = await getOrCreateSite(clientId, createdBy);
  // Phase 2 — same slug is allowed across different languages so
  // English and Spanish siblings can share a clean URL stem. The
  // SLUG_TAKEN check below is now language-scoped via the
  // (clientId, slug, language) compound unique.
  const language = input.language ?? "en";
  const existing = await prisma.sitePage.findUnique({
    where: {
      clientId_slug_language: { clientId, slug: input.slug, language },
    },
    select: { id: true },
  });
  if (existing) {
    const err = new Error("A page with this slug already exists");
    err.status = 409;
    err.code = "SLUG_TAKEN";
    throw err;
  }
  // If a page is created from a CAMPAIGN source, mirror sourceId
  // back into campaignId so the existing FK relation continues to
  // work. For non-campaign sources we leave campaignId null.
  const sourceType = input.sourceType ?? null;
  const sourceId = input.sourceId ?? null;
  const derivedCampaignId =
    input.campaignId ??
    (sourceType === "CAMPAIGN" && sourceId ? sourceId : null);
  return prisma.sitePage.create({
    data: {
      siteId: site.id,
      clientId,
      slug: input.slug,
      title: input.title,
      description: input.description ?? null,
      status: "DRAFT",
      blocksJson: input.blocksJson || [],
      campaignId: derivedCampaignId,
      sourceType,
      sourceId,
      pageGoal: input.pageGoal ?? null,
      noIndex: input.noIndex ?? false,
      heroImageId: input.heroImageId ?? null,
      seoTitle: input.seoTitle ?? null,
      seoDescription: input.seoDescription ?? null,
      ogImageId: input.ogImageId ?? null,
      revalidateSec: input.revalidateSec ?? 60,
      // Phase 1 multilingual — fall through the column default
      // ("en") when the caller doesn't pass a language so existing
      // manual create paths stay unchanged.
      ...(input.language ? { language: input.language } : {}),
      createdBy,
    },
  });
}

export async function updatePage(clientId, pageId, patch) {
  const page = await prisma.sitePage.findFirst({
    where: { id: pageId, clientId },
    select: { id: true, slug: true, status: true, language: true },
  });
  if (!page) {
    const err = new Error("Page not found");
    err.status = 404;
    err.code = "PAGE_NOT_FOUND";
    throw err;
  }

  // If slug changes, ensure uniqueness within the workspace —
  // scoped to this page's language so an English page renaming to
  // "spring-open-house" doesn't collide with the Spanish sibling
  // that already uses the same slug.
  if (patch.slug && patch.slug !== page.slug) {
    const conflict = await prisma.sitePage.findUnique({
      where: {
        clientId_slug_language: {
          clientId,
          slug: patch.slug,
          language: page.language ?? "en",
        },
      },
      select: { id: true },
    });
    if (conflict && conflict.id !== pageId) {
      const err = new Error("A page with this slug already exists");
      err.status = 409;
      err.code = "SLUG_TAKEN";
      throw err;
    }
  }

  const updated = await prisma.sitePage.update({
    where: { id: pageId },
    data: {
      slug: patch.slug,
      title: patch.title,
      description: patch.description === undefined ? undefined : patch.description,
      status: patch.status,
      blocksJson: patch.blocksJson === undefined ? undefined : patch.blocksJson,
      campaignId: patch.campaignId === undefined ? undefined : patch.campaignId,
      sourceType: patch.sourceType === undefined ? undefined : patch.sourceType,
      sourceId: patch.sourceId === undefined ? undefined : patch.sourceId,
      pageGoal: patch.pageGoal === undefined ? undefined : patch.pageGoal,
      noIndex: patch.noIndex === undefined ? undefined : patch.noIndex,
      heroImageId: patch.heroImageId === undefined ? undefined : patch.heroImageId,
      seoTitle: patch.seoTitle === undefined ? undefined : patch.seoTitle,
      seoDescription:
        patch.seoDescription === undefined ? undefined : patch.seoDescription,
      ogImageId: patch.ogImageId === undefined ? undefined : patch.ogImageId,
      revalidateSec: patch.revalidateSec,
      // Stamp publishedAt the first time a draft transitions to PUBLISHED.
      publishedAt:
        patch.status === "PUBLISHED" && page.status !== "PUBLISHED"
          ? new Date()
          : undefined,
    },
  });

  // Best-effort revalidate when content changes on an already-
  // published page so the runtime drops cached HTML immediately.
  if (
    (patch.status === "PUBLISHED" || updated.status === "PUBLISHED") &&
    (patch.blocksJson !== undefined ||
      patch.title !== undefined ||
      patch.description !== undefined ||
      patch.status === "PUBLISHED")
  ) {
    await maybeRevalidate(clientId, updated.slug);
  }

  return updated;
}

export async function publishPage(clientId, pageId) {
  const page = await prisma.sitePage.findFirst({
    where: { id: pageId, clientId },
    select: { id: true, slug: true, status: true, siteId: true },
  });
  if (!page) {
    const err = new Error("Page not found");
    err.status = 404;
    err.code = "PAGE_NOT_FOUND";
    throw err;
  }
  // Auto-publish the parent Site as well — a published page on a
  // DRAFT site is unreachable from the public runtime.
  await prisma.site.update({
    where: { id: page.siteId },
    data: { status: "PUBLISHED" },
  });
  const updated = await prisma.sitePage.update({
    where: { id: page.id },
    data: {
      status: "PUBLISHED",
      publishedAt: page.status === "PUBLISHED" ? undefined : new Date(),
    },
  });
  await maybeRevalidate(clientId, updated.slug);
  return updated;
}

export async function unpublishPage(clientId, pageId) {
  const page = await prisma.sitePage.findFirst({
    where: { id: pageId, clientId },
    select: { id: true, slug: true },
  });
  if (!page) {
    const err = new Error("Page not found");
    err.status = 404;
    err.code = "PAGE_NOT_FOUND";
    throw err;
  }
  const updated = await prisma.sitePage.update({
    where: { id: page.id },
    data: { status: "DRAFT" },
  });
  // Revalidate so the runtime serves the latest (now-404) state.
  await maybeRevalidate(clientId, updated.slug);
  return updated;
}

export async function deletePage(clientId, pageId) {
  const page = await prisma.sitePage.findFirst({
    where: { id: pageId, clientId },
    select: { id: true, slug: true, status: true },
  });
  if (!page) {
    const err = new Error("Page not found");
    err.status = 404;
    err.code = "PAGE_NOT_FOUND";
    throw err;
  }
  await prisma.sitePage.delete({ where: { id: page.id } });
  if (page.status === "PUBLISHED") {
    await maybeRevalidate(clientId, page.slug);
  }
  return { id: page.id };
}

// ── LeadForm ────────────────────────────────────────────────────────────

export async function listForms(clientId) {
  return prisma.leadForm.findMany({
    where: { clientId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      notifyEmail: true,
      fieldsJson: true,
      successAction: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { submissions: true } },
    },
  });
}

export async function getForm(clientId, formId) {
  return prisma.leadForm.findFirst({
    where: { id: formId, clientId },
  });
}

export async function createForm(clientId, createdBy, input) {
  const site = await getOrCreateSite(clientId, createdBy);
  return prisma.leadForm.create({
    data: {
      siteId: site.id,
      clientId,
      name: input.name,
      fieldsJson: input.fieldsJson,
      successAction: input.successAction,
      notifyEmail: input.notifyEmail ?? null,
    },
  });
}

export async function updateForm(clientId, formId, patch) {
  const form = await prisma.leadForm.findFirst({
    where: { id: formId, clientId },
    select: { id: true },
  });
  if (!form) {
    const err = new Error("Form not found");
    err.status = 404;
    err.code = "FORM_NOT_FOUND";
    throw err;
  }
  return prisma.leadForm.update({
    where: { id: formId },
    data: {
      name: patch.name,
      fieldsJson: patch.fieldsJson,
      successAction: patch.successAction,
      notifyEmail: patch.notifyEmail === undefined ? undefined : patch.notifyEmail,
    },
  });
}

export async function deleteForm(clientId, formId) {
  const form = await prisma.leadForm.findFirst({
    where: { id: formId, clientId },
    select: { id: true },
  });
  if (!form) {
    const err = new Error("Form not found");
    err.status = 404;
    err.code = "FORM_NOT_FOUND";
    throw err;
  }
  await prisma.leadForm.delete({ where: { id: formId } });
  return { id: formId };
}

// ── FormSubmission ──────────────────────────────────────────────────────

export async function listSubmissions(clientId, { status, formId, limit, cursor }) {
  const where = { clientId };
  if (status) where.status = status;
  if (formId) where.formId = formId;
  const rows = await prisma.formSubmission.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: {
      id: true,
      formId: true,
      campaignId: true,
      pageId: true,
      dataJson: true,
      contactEmail: true,
      contactPhone: true,
      status: true,
      createdAt: true,
      form: { select: { id: true, name: true } },
    },
  });
  const nextCursor = rows.length > limit ? rows.pop().id : null;
  return { submissions: rows, nextCursor };
}

export async function updateSubmissionStatus(clientId, submissionId, status) {
  const row = await prisma.formSubmission.findFirst({
    where: { id: submissionId, clientId },
    select: { id: true },
  });
  if (!row) {
    const err = new Error("Submission not found");
    err.status = 404;
    err.code = "SUBMISSION_NOT_FOUND";
    throw err;
  }
  return prisma.formSubmission.update({
    where: { id: submissionId },
    data: { status },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Resolve clientId → client.slug, then fire the revalidate webhook.
// Fire-and-forget; failures are logged but never block the API
// response. The runtime will catch up on the next natural ISR cycle.
async function maybeRevalidate(clientId, pageSlug) {
  try {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { slug: true },
    });
    if (!client?.slug) return;
    const result = await triggerRuntimeRevalidate({
      clientSlug: client.slug,
      pageSlug,
    });
    if (!result.ok) {
      // Best-effort log; not all environments have a logger here.
      console.warn(
        `[sites.dashboard] revalidate failed clientSlug=${client.slug} pageSlug=${pageSlug} reason=${result.reason ?? result.status}`,
      );
    }
  } catch (err) {
    console.warn("[sites.dashboard] revalidate threw:", err?.message ?? err);
  }
}
