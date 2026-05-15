// SquadAds export — turn an AdPackage into a self-contained
// artifact the user can paste into Meta Ads Manager / Google Ads /
// hand to an agency. MVP supports two formats:
//
//   - 'json'      — full structured bundle, suitable for programmatic
//                   ingestion by future tooling.
//   - 'markdown'  — human-readable copyable text with sections for
//                   creatives, audience, budget, destination, and a
//                   compliance disclaimer.
//
// The export endpoint is the only place that can flip status to
// EXPORTED. Status must be READY first — that gate is enforced
// upstream by the service's readiness checks.

import { prisma } from "../../prisma.js";

export class ExportError extends Error {
  constructor(message, { status = 400, code = "EXPORT_FAILED" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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

export async function exportPackage(clientId, packageId, userId, { format = "json" } = {}) {
  const pkg = await prisma.adPackage.findFirst({
    where: { id: packageId, clientId },
    include: {
      creatives: { orderBy: { variantIndex: "asc" } },
      audience: true,
      budget: true,
      destination: true,
    },
  });
  if (!pkg) throw new ExportError("Ad package not found", { status: 404, code: "AD_PACKAGE_NOT_FOUND" });
  if (pkg.status !== "READY" && pkg.status !== "EXPORTED") {
    throw new ExportError("Package must be READY before exporting", {
      status: 400,
      code: "PACKAGE_NOT_READY",
    });
  }
  if (!pkg.creatives || pkg.creatives.length === 0) {
    throw new ExportError("Package has no creatives", { status: 400, code: "NO_CREATIVES" });
  }

  const sourceSummary = await resolveSourceSummaryForExport(pkg);
  const destinationUrl = buildDestinationUrl(pkg.destination);
  const mediaList = await resolveMediaList(pkg.creatives);

  const bundle = {
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

  const content = format === "markdown" ? renderMarkdown(bundle) : JSON.stringify(bundle, null, 2);
  const mimeType = format === "markdown" ? "text/markdown; charset=utf-8" : "application/json";
  const filename = `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.${format === "markdown" ? "md" : "json"}`;

  // Append to the package's export history. We store metadata only
  // (no blob in DB) — the bytes are streamed in the response.
  const exportsEntry = {
    format,
    filename,
    generatedAt: new Date().toISOString(),
    generatedBy: userId,
  };
  const existingExports = Array.isArray(pkg.exportsJson) ? pkg.exportsJson : [];
  await prisma.adPackage.update({
    where: { id: pkg.id },
    data: {
      exportsJson: [...existingExports, exportsEntry],
      status: pkg.status === "READY" ? "EXPORTED" : pkg.status,
    },
  });

  return { filename, mimeType, content, bundle };
}

async function resolveSourceSummaryForExport(pkg) {
  if (!pkg.sourceType) return null;
  if (pkg.sourceType === "IDEA") return { kind: "IDEA", text: pkg.sourceIdea ?? null };
  if (!pkg.sourceId) return { kind: pkg.sourceType, id: null };
  switch (pkg.sourceType) {
    case "CAMPAIGN": {
      const row = await prisma.campaign.findUnique({
        where: { id: pkg.sourceId },
        select: { id: true, name: true, campaignType: true },
      });
      return row ? { kind: "CAMPAIGN", ...row } : null;
    }
    case "SITE_PAGE": {
      const row = await prisma.sitePage.findUnique({
        where: { id: pkg.sourceId },
        select: { id: true, title: true, slug: true },
      });
      return row ? { kind: "SITE_PAGE", ...row } : null;
    }
    case "DRAFT": {
      const row = await prisma.draft.findUnique({
        where: { id: pkg.sourceId },
        select: { id: true, channel: true },
      });
      return row ? { kind: "DRAFT", ...row } : null;
    }
    case "PROPERTY":
    case "CONTENT_ASSET": {
      const row = await prisma.workspaceDataItem.findUnique({
        where: { id: pkg.sourceId },
        select: { id: true, type: true, title: true },
      });
      return row ? { kind: pkg.sourceType, ...row } : null;
    }
    default:
      return { kind: pkg.sourceType, id: pkg.sourceId };
  }
}

async function resolveMediaList(creatives) {
  const out = { byCreativeId: {} };
  // Bulk-fetch all primary asset ids so the export is O(1) DB hits
  // regardless of variant count.
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
    where: { id: { in: [...ids] } },
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

function buildDestinationUrl(destination) {
  if (!destination) return null;
  let base = null;
  if (destination.kind === "EXTERNAL_URL") base = destination.externalUrl ?? null;
  else if (destination.kind === "SITE_PAGE") base = destination.sitePageId ? `squadsite://page/${destination.sitePageId}` : null;
  else if (destination.kind === "SOCIAL_PROFILE") base = destination.socialProfile ?? null;
  if (!base) return null;

  const utm = destination.utmJson;
  if (!utm || typeof utm !== "object") return base;
  const params = new URLSearchParams();
  for (const k of ["source", "medium", "campaign", "content", "term"]) {
    const v = utm[k];
    if (typeof v === "string" && v.trim()) params.set(`utm_${k}`, v.trim());
  }
  if ([...params.keys()].length === 0) return base;
  // Only append UTMs to a real URL — internal squadsite:// scheme
  // shouldn't carry them in the export.
  if (!base.startsWith("http")) return base;
  return base.includes("?") ? `${base}&${params.toString()}` : `${base}?${params.toString()}`;
}

function renderMarkdown(bundle) {
  const lines = [];
  lines.push(`# ${bundle.package.name}`);
  lines.push("");
  lines.push(`**Objective:** ${bundle.package.objective}`);
  lines.push(`**Status:** ${bundle.package.status}`);
  lines.push(`**Special category:** ${bundle.package.specialCategory}`);
  lines.push(`**Exported:** ${bundle.exportedAt}`);
  if (bundle.package.source) {
    lines.push("");
    lines.push("## Source");
    lines.push(`- ${bundle.package.source.kind}: ${describeSource(bundle.package.source)}`);
  }

  lines.push("");
  lines.push("## Destination");
  if (bundle.destination) {
    lines.push(`- Kind: ${bundle.destination.kind}`);
    if (bundle.destination.url) lines.push(`- URL: ${bundle.destination.url}`);
    if (bundle.destination.socialProfile) lines.push(`- Social profile: ${bundle.destination.socialProfile}`);
    if (bundle.destination.pixelIds.length > 0) lines.push(`- Pixels: ${bundle.destination.pixelIds.join(", ")}`);
  } else {
    lines.push("_(no destination configured)_");
  }

  lines.push("");
  lines.push("## Creatives");
  for (const c of bundle.creatives) {
    lines.push("");
    lines.push(`### Variant ${c.variantIndex}${c.channelHint ? ` — ${c.channelHint}` : ""}`);
    lines.push(`**Headline:** ${c.headline}`);
    lines.push("");
    lines.push(`**Primary text:**`);
    lines.push(c.primaryText);
    if (c.description) lines.push("", `**Description:** ${c.description}`);
    if (c.cta) lines.push("", `**CTA:** ${c.cta}`);
    if (c.primaryAssetUrl) lines.push("", `**Primary asset:** ${c.primaryAssetUrl}`);
    if (c.additionalAssetUrls.length > 0) {
      lines.push("", `**Additional assets:**`);
      for (const u of c.additionalAssetUrls) lines.push(`- ${u}`);
    }
    if (c.rationale) lines.push("", `_${c.rationale}_`);
  }

  if (bundle.audience) {
    lines.push("");
    lines.push("## Audience");
    if (bundle.audience.locations.length > 0) {
      lines.push(
        `- Locations: ${bundle.audience.locations.map((l) => `${l.value} (${l.kind})`).join(", ")}`,
      );
    }
    if (bundle.audience.ageMin || bundle.audience.ageMax) {
      lines.push(`- Age range: ${bundle.audience.ageMin ?? "—"} to ${bundle.audience.ageMax ?? "—"}`);
    }
    lines.push(`- Genders: ${(bundle.audience.genders || []).join(", ") || "all"}`);
    if (bundle.audience.interests.length > 0) {
      lines.push(`- Interests: ${bundle.audience.interests.join(", ")}`);
    }
    if (bundle.audience.languages.length > 0) {
      lines.push(`- Languages: ${bundle.audience.languages.join(", ")}`);
    }
    if (bundle.audience.customAudienceHints.length > 0) {
      lines.push("- Custom audiences:");
      for (const h of bundle.audience.customAudienceHints) {
        lines.push(`  - ${h.kind}: ${h.description}`);
      }
    }
    if (bundle.audience.housingRestricted) {
      lines.push("- ⚠ Housing-restricted: demographic targeting cleared.");
    }
  }

  if (bundle.budget) {
    lines.push("");
    lines.push("## Budget");
    if (bundle.budget.dailyBudgetCents != null) {
      lines.push(`- Daily: ${formatMoney(bundle.budget.dailyBudgetCents, bundle.budget.currency)}`);
    }
    if (bundle.budget.totalBudgetCents != null) {
      lines.push(`- Total: ${formatMoney(bundle.budget.totalBudgetCents, bundle.budget.currency)}`);
    }
    if (bundle.budget.durationDays) lines.push(`- Duration: ${bundle.budget.durationDays} days`);
    if (bundle.budget.startsAt) lines.push(`- Starts: ${new Date(bundle.budget.startsAt).toISOString().slice(0, 10)}`);
    if (bundle.budget.endsAt) lines.push(`- Ends: ${new Date(bundle.budget.endsAt).toISOString().slice(0, 10)}`);
  }

  lines.push("");
  lines.push("## Compliance");
  lines.push("");
  lines.push(bundle.compliance.notLaunchedDisclaimer);
  if (bundle.compliance.housingDisclaimer) {
    lines.push("");
    lines.push(bundle.compliance.housingDisclaimer);
  }
  if (bundle.compliance.reviewNotes) {
    lines.push("");
    lines.push("**Internal review notes:**");
    lines.push(bundle.compliance.reviewNotes);
  }
  return lines.join("\n");
}

function describeSource(source) {
  if (source.kind === "IDEA") return source.text ? source.text.slice(0, 200) : "(idea)";
  if (source.name) return source.name;
  if (source.title) return source.title;
  return source.id ?? "(unknown)";
}

function formatMoney(cents, currency = "USD") {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function slugifyForFilename(s) {
  return String(s || "ad-package")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "ad-package";
}
