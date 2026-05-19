// Ads-04 — canonical bundle builder.
//
// `exportPackage()` runs this once per export to produce the
// SquadAds-canonical shape, then hands the bundle to the
// per-format renderer registered in ./index.js. Keeping bundle
// construction here (instead of inline in the renderer) means a
// new platform exporter only has to know how to translate the
// canonical bundle — not how to read AdPackage rows + fan out to
// pages/clients/media.
//
// The shape produced here is also the wire format of
// `squadads_json` (the internal developer export), so any breaking
// change must bump `schemaVersion`.

import { prisma } from "../../../prisma.js";
import { buildPublicSitePageUrl } from "../../sites/sites.service.js";
import { ExportError } from "../ads.export.errors.js";

const COMPLIANCE_DISCLAIMER = `
NOT LAUNCHED BY SQUADPITCH

Squadpitch generated this package as an export bundle. We do NOT
publish ads on your behalf. To run this campaign you (or your
paid-media team) must:

1. Sign in to Meta Ads Manager / Google Ads / TikTok Ads /
   LinkedIn Campaign Manager / Pinterest Ads on your own account.
2. Upload the creatives + recreate the audience and budget below.
3. Review the destination URL and apply your own pixel /
   conversion tracking.
4. Submit the ad through the platform's own review process.

Final compliance + spend authority is yours.
`.trim();

const HOUSING_DISCLAIMER = `
HOUSING SPECIAL AD CATEGORY (Fair Housing Act)

This package contains housing-related content. Under the U.S.
Fair Housing Act and Meta's Special Ad Category rules, you must:

- Not target by age narrower than 18-65, gender, or ZIP codes
  alone (city/region with ≥15-mile radius is fine).
- Not use protected-class language ("young professionals",
  "family-friendly neighborhood", "mature buyers", etc.).
- Mark the campaign as HOUSING in Meta Ads Manager.

Demographic fields in this export have been cleared by Squadpitch
to comply. Review the copy for any protected-class language
before launching.
`.trim();

export async function buildCanonicalBundle(pkg) {
  const sourceSummary = await resolveSourceSummaryForExport(pkg, pkg.clientId);
  // Resolve SITE_PAGE destinations up front. We never emit a
  // squadsite:// placeholder or a URL the lead can't click — the
  // validator already rejected unpublished/foreign pages, so this
  // is belt-and-suspenders for legacy callers.
  const destinationUrl = await buildDestinationUrl(pkg.destination, pkg.clientId);
  const mediaList = await resolveMediaList(pkg.creatives, pkg.clientId);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    package: {
      id: pkg.id,
      name: pkg.name,
      objective: pkg.objective,
      status: pkg.status,
      specialCategory: pkg.specialCategory,
      source: sourceSummary,
    },
    creatives: pkg.creatives.map((c) => ({
      variantIndex: c.variantIndex,
      channelHint: c.channel ?? null,
      headline: c.headline,
      primaryText: c.primaryText,
      description: c.description ?? null,
      cta: c.cta ?? null,
      primaryAssetUrl:
        mediaList.byCreativeId[c.id]?.primary?.url ?? null,
      additionalAssetUrls:
        mediaList.byCreativeId[c.id]?.additional?.map((a) => a.url).filter(Boolean) ?? [],
      rationale: c.rationale ?? null,
    })),
    audience: pkg.audience
      ? {
          locations: pkg.audience.locationsJson ?? [],
          ageMin: pkg.audience.ageMin ?? null,
          ageMax: pkg.audience.ageMax ?? null,
          genders: pkg.audience.gendersJson ?? ["all"],
          interests: pkg.audience.interestsJson ?? [],
          customAudienceHints: pkg.audience.customAudienceHintsJson ?? [],
          languages: pkg.audience.languagesJson ?? [],
          housingRestricted: pkg.audience.housingRestricted ?? false,
        }
      : null,
    budget: pkg.budget
      ? {
          dailyBudgetCents: pkg.budget.dailyBudgetCents ?? null,
          totalBudgetCents: pkg.budget.totalBudgetCents ?? null,
          currency: pkg.budget.currency ?? "USD",
          durationDays: pkg.budget.durationDays ?? null,
          startsAt: pkg.budget.startsAt ?? null,
          endsAt: pkg.budget.endsAt ?? null,
        }
      : null,
    destination: pkg.destination
      ? {
          kind: pkg.destination.kind,
          url: destinationUrl,
          sitePageId: pkg.destination.sitePageId ?? null,
          socialProfile: pkg.destination.socialProfile ?? null,
          utm: pkg.destination.utmJson ?? null,
          pixelIds: pkg.destination.pixelIdsJson ?? [],
        }
      : null,
    compliance: {
      notLaunchedDisclaimer: COMPLIANCE_DISCLAIMER,
      housingDisclaimer: pkg.specialCategory === "HOUSING" ? HOUSING_DISCLAIMER : null,
      reviewNotes: pkg.reviewNotes ?? null,
    },
  };
}

async function resolveSourceSummaryForExport(pkg, clientId) {
  if (!pkg.sourceType) return null;
  if (pkg.sourceType === "IDEA") return { kind: "IDEA", text: pkg.sourceIdea ?? null };
  if (!pkg.sourceId) return { kind: pkg.sourceType, id: null };
  switch (pkg.sourceType) {
    case "CAMPAIGN": {
      const row = await prisma.campaign.findFirst({
        where: { id: pkg.sourceId, clientId },
        select: { id: true, name: true, campaignType: true },
      });
      return row ? { kind: "CAMPAIGN", ...row } : null;
    }
    case "SITE_PAGE": {
      const row = await prisma.sitePage.findFirst({
        where: { id: pkg.sourceId, clientId },
        select: { id: true, title: true, slug: true },
      });
      return row ? { kind: "SITE_PAGE", ...row } : null;
    }
    case "DRAFT": {
      const row = await prisma.draft.findFirst({
        where: { id: pkg.sourceId, clientId },
        select: { id: true, channel: true },
      });
      return row ? { kind: "DRAFT", ...row } : null;
    }
    case "PROPERTY":
    case "CONTENT_ASSET": {
      const row = await prisma.workspaceDataItem.findFirst({
        where: { id: pkg.sourceId, clientId },
        select: { id: true, type: true, title: true },
      });
      return row ? { kind: pkg.sourceType, ...row } : null;
    }
    default:
      return { kind: pkg.sourceType, id: pkg.sourceId };
  }
}

async function resolveMediaList(creatives, clientId) {
  const out = { byCreativeId: {} };
  const ids = new Set();
  for (const c of creatives) {
    if (c.primaryAssetId) ids.add(c.primaryAssetId);
    if (Array.isArray(c.additionalAssetIdsJson)) {
      for (const a of c.additionalAssetIdsJson) if (typeof a === "string") ids.add(a);
    }
  }
  if (ids.size === 0) {
    for (const c of creatives) out.byCreativeId[c.id] = { primary: null, additional: [] };
    return out;
  }
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: [...ids] }, clientId },
    select: { id: true, url: true, thumbnailUrl: true, mimeType: true, assetType: true, altText: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const c of creatives) {
    const primary = c.primaryAssetId ? byId.get(c.primaryAssetId) ?? null : null;
    const additionalIds = Array.isArray(c.additionalAssetIdsJson)
      ? c.additionalAssetIdsJson.filter((x) => typeof x === "string")
      : [];
    const additional = additionalIds.map((id) => byId.get(id)).filter(Boolean);
    out.byCreativeId[c.id] = { primary, additional };
  }
  return out;
}

async function buildDestinationUrl(destination, clientId) {
  if (!destination) return null;
  let base = null;
  if (destination.kind === "EXTERNAL_URL") {
    base = destination.externalUrl ?? null;
  } else if (destination.kind === "SOCIAL_PROFILE") {
    base = destination.socialProfile ?? null;
  } else if (destination.kind === "SITE_PAGE") {
    base = await resolveSitePageDestinationUrl(destination.sitePageId, clientId);
  }
  if (!base) return null;

  const utm = destination.utmJson;
  if (!utm || typeof utm !== "object") return base;
  const params = new URLSearchParams();
  for (const k of ["source", "medium", "campaign", "content", "term"]) {
    const v = utm[k];
    if (typeof v === "string" && v.trim()) params.set(`utm_${k}`, v.trim());
  }
  if ([...params.keys()].length === 0) return base;
  if (!base.startsWith("http")) return base;
  return base.includes("?") ? `${base}&${params.toString()}` : `${base}?${params.toString()}`;
}

async function resolveSitePageDestinationUrl(sitePageId, clientId) {
  if (!sitePageId) {
    throw new ExportError(
      "SITE_PAGE destination has no sitePageId configured",
      { status: 400, code: "DESTINATION_MISSING_SITE_PAGE" },
    );
  }
  const page = await prisma.sitePage.findUnique({
    where: { id: sitePageId },
    select: { id: true, slug: true, status: true, clientId: true },
  });
  if (!page) {
    throw new ExportError(
      "Destination SquadSite page not found",
      { status: 404, code: "SITE_PAGE_NOT_FOUND" },
    );
  }
  if (page.clientId !== clientId) {
    throw new ExportError(
      "Destination SquadSite page not found",
      { status: 404, code: "SITE_PAGE_NOT_FOUND" },
    );
  }
  if (page.status !== "PUBLISHED") {
    throw new ExportError(
      "Destination SquadSite page must be published before export",
      { status: 400, code: "SITE_PAGE_NOT_PUBLISHED" },
    );
  }
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { slug: true },
  });
  const url = buildPublicSitePageUrl({
    clientSlug: client?.slug,
    pageSlug: page.slug,
  });
  if (!url) {
    throw new ExportError(
      "Workspace has no public slug configured — cannot build destination URL",
      { status: 400, code: "WORKSPACE_SLUG_MISSING" },
    );
  }
  return url;
}
