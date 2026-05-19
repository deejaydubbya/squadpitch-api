// Authenticated SquadAds service.
//
// MVP is export-only. Every "publish"-like affordance is actually
// just persisting a richer AdPackage row + producing a downloadable
// artifact. No call to any ad-platform API.
//
// Every helper is workspace-scoped — clientId filters every query
// in addition to the requireClientOwner middleware running on the
// route. Defense in depth.

import { prisma } from "../../prisma.js";
import { loadClientGenerationContext } from "../studio/generation/clientOrchestrator.js";
import { generateStructuredContent } from "../studio/generation/openai.provider.js";
import { trackAiUsage } from "../billing/aiUsageTracking.service.js";
import { buildPublicSitePageUrl } from "../sites/sites.service.js";
import { lintCreativeCopy } from "./ads.compliance.js";

// ── List + detail ──────────────────────────────────────────────────────

export async function listPackages(clientId, { status, limit, cursor }) {
  const where = { clientId };
  if (status) where.status = status;
  const rows = await prisma.adPackage.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    include: {
      creatives: {
        orderBy: { variantIndex: "asc" },
        take: 1,
        select: { id: true, variantIndex: true, headline: true, primaryAssetId: true },
      },
      destination: {
        select: { kind: true, sitePageId: true, externalUrl: true },
      },
    },
  });
  const nextCursor = rows.length > limit ? rows.pop().id : null;
  return { packages: rows, nextCursor };
}

export async function getPackage(clientId, packageId) {
  const row = await prisma.adPackage.findFirst({
    where: { id: packageId, clientId },
    include: {
      creatives: { orderBy: { variantIndex: "asc" } },
      audience: true,
      budget: true,
      destination: true,
    },
  });
  if (!row) return null;
  // Resolve source context for the UI's "Source" card. Tightly
  // whitelisted — never expose page blocksJson or data item dataJson
  // raw, the AI prompt builder handles that separately.
  const sourceSummary = await resolveSourceSummary(row);
  // For SITE_PAGE destinations, resolve the public URL so the
  // detail editor can show what the export will produce. Warnings
  // surface here too — the UI uses them to show "page must be
  // published" before the user even clicks Export.
  const destinationPreview = await resolveDestinationPreview(row);
  return { ...row, sourceSummary, destinationPreview };
}

// Returns { resolvedUrl, warning } for the UI. Mirrors the export
// service's rules but never throws — warnings are surfaced as text
// instead so the user can fix them inline.
async function resolveDestinationPreview(pkg) {
  if (!pkg.destination) return null;
  const dest = pkg.destination;
  if (dest.kind === "EXTERNAL_URL") {
    return { resolvedUrl: dest.externalUrl ?? null, warning: null };
  }
  if (dest.kind === "SOCIAL_PROFILE") {
    return { resolvedUrl: dest.socialProfile ?? null, warning: null };
  }
  if (dest.kind !== "SITE_PAGE") return null;
  if (!dest.sitePageId) {
    return {
      resolvedUrl: null,
      warning: "Pick a SquadSite page for this destination.",
    };
  }
  const page = await prisma.sitePage.findUnique({
    where: { id: dest.sitePageId },
    select: { id: true, slug: true, status: true, clientId: true, title: true },
  });
  if (!page || page.clientId !== pkg.clientId) {
    // 404-equivalent — never leak existence across tenants in the warning text.
    return {
      resolvedUrl: null,
      warning: "Selected SquadSite page is unavailable. Pick a different page.",
    };
  }
  if (page.status !== "PUBLISHED") {
    return {
      resolvedUrl: null,
      warning: `Page "${page.title}" must be published before export.`,
    };
  }
  const client = await prisma.client.findUnique({
    where: { id: pkg.clientId },
    select: { slug: true },
  });
  const url = buildPublicSitePageUrl({
    clientSlug: client?.slug,
    pageSlug: page.slug,
  });
  if (!url) {
    return {
      resolvedUrl: null,
      warning: "Workspace has no public slug yet — contact support.",
    };
  }
  return { resolvedUrl: url, warning: null };
}

async function resolveSourceSummary(pkg) {
  if (!pkg.sourceId && pkg.sourceType !== "IDEA") return null;
  // Ads-01 — tenant-scope every lookup so a stale / spoofed sourceId
  // pointing at another workspace returns null instead of leaking
  // the source row. The package's own clientId is the trust anchor.
  switch (pkg.sourceType) {
    case "CAMPAIGN": {
      const row = await prisma.campaign.findFirst({
        where: { id: pkg.sourceId, clientId: pkg.clientId },
        select: { id: true, name: true, campaignType: true, status: true },
      });
      return row ? { kind: "campaign", ...row } : null;
    }
    case "SITE_PAGE": {
      const row = await prisma.sitePage.findFirst({
        where: { id: pkg.sourceId, clientId: pkg.clientId },
        select: { id: true, title: true, slug: true, status: true },
      });
      return row ? { kind: "site_page", ...row } : null;
    }
    case "DRAFT": {
      const row = await prisma.draft.findFirst({
        where: { id: pkg.sourceId, clientId: pkg.clientId },
        select: { id: true, channel: true, body: true, status: true },
      });
      if (!row) return null;
      return {
        kind: "draft",
        id: row.id,
        channel: row.channel,
        status: row.status,
        bodyPreview: row.body ? row.body.slice(0, 200) : null,
      };
    }
    case "PROPERTY":
    case "CONTENT_ASSET": {
      const row = await prisma.workspaceDataItem.findFirst({
        where: { id: pkg.sourceId, clientId: pkg.clientId },
        select: { id: true, type: true, title: true, summary: true },
      });
      return row ? { kind: "data_item", ...row } : null;
    }
    case "IDEA":
      return { kind: "idea", text: pkg.sourceIdea ?? null };
    default:
      return null;
  }
}

// ── Create ─────────────────────────────────────────────────────────────

export async function createPackage(clientId, userId, input) {
  // Ads-01 — tenant-scope the source before persisting. IDEA sources
  // skip the DB lookup but still require a non-empty sourceIdea.
  await assertSourceOwned(clientId, input.sourceType, input.sourceId, input.sourceIdea);

  // Auto-tag HOUSING for property-sourced packages and for real-
  // estate workspaces. Users can manually override via PATCH.
  const specialCategory = await deriveInitialSpecialCategory(clientId, input);

  // Ads-01 — when the wizard pre-seeds a destination with a
  // SITE_PAGE, validate that the sitePage belongs to this client too.
  if (input.destination?.kind === "SITE_PAGE" && input.destination.sitePageId) {
    const sp = await prisma.sitePage.findFirst({
      where: { id: input.destination.sitePageId, clientId },
      select: { id: true },
    });
    if (!sp) {
      const err = new Error("Destination site page not found in this workspace");
      err.status = 404;
      err.code = "SOURCE_NOT_FOUND_OR_FORBIDDEN";
      throw err;
    }
  }

  const created = await prisma.adPackage.create({
    data: {
      clientId,
      name: input.name,
      objective: input.objective,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceIdea: input.sourceIdea ?? null,
      specialCategory,
      createdBy: userId,
      // Pre-seed an empty destination row if the wizard already
      // picked one — keeps the detail editor from showing a "click
      // to add destination" empty slot on first load.
      destination: input.destination
        ? {
            create: {
              kind: input.destination.kind,
              sitePageId: input.destination.sitePageId ?? null,
              externalUrl: input.destination.externalUrl ?? null,
              socialProfile: input.destination.socialProfile ?? null,
            },
          }
        : undefined,
    },
    include: {
      creatives: true,
      audience: true,
      budget: true,
      destination: true,
    },
  });
  return created;
}

async function deriveInitialSpecialCategory(clientId, input) {
  if (input.sourceType === "PROPERTY") return "HOUSING";
  // Workspace industry signal — real estate workspaces default
  // everything to HOUSING. The brand profile carries the industry.
  const brand = await prisma.brandProfile
    .findUnique({
      where: { clientId },
      select: { industry: true },
    })
    .catch(() => null);
  if (brand?.industry === "real_estate") return "HOUSING";
  return "NONE";
}

// ── Update ─────────────────────────────────────────────────────────────

export async function updatePackage(clientId, packageId, userId, patch) {
  const existing = await prisma.adPackage.findFirst({
    where: { id: packageId, clientId },
    include: { creatives: true, audience: true, budget: true, destination: true },
  });
  if (!existing) {
    const err = new Error("Ad package not found");
    err.status = 404;
    err.code = "AD_PACKAGE_NOT_FOUND";
    throw err;
  }

  // Status transitions:
  //   DRAFT → READY      requires the readiness checklist + review stamp
  //   READY → DRAFT      always allowed (user pulls it back to edit)
  //   any → ARCHIVED     soft delete
  // EXPORTED is service-managed (set by the export endpoint).
  if (patch.status) {
    if (patch.status === "READY") {
      await validatePackageReady(existing);
    }
    if (existing.status === "EXPORTED" && patch.status !== "ARCHIVED") {
      const err = new Error("Exported packages can only be archived");
      err.status = 400;
      err.code = "INVALID_STATUS_TRANSITION";
      throw err;
    }
  }

  const data = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.specialCategory !== undefined) {
    data.specialCategory = patch.specialCategory;
    // Re-apply housing-restricted clearing if the category flipped on.
    if (patch.specialCategory !== "NONE" && existing.audience) {
      await applyHousingRestrictedClearing(existing.audience.id);
    }
  }
  if (patch.reviewNotes !== undefined) data.reviewNotes = patch.reviewNotes;
  if (patch.acknowledgeReview === true) {
    data.reviewedByUserId = userId;
    data.reviewedAt = new Date();
  }

  return prisma.adPackage.update({
    where: { id: packageId },
    data,
    include: {
      creatives: { orderBy: { variantIndex: "asc" } },
      audience: true,
      budget: true,
      destination: true,
    },
  });
}

// Ads-02 — production-grade READY/export gate. Replaces the
// previous existence-only check (≥1 creative, audience populated,
// etc.) with content + compliance validation:
//
//   - Creative content non-empty after trim.
//   - Budget has at least one positive amount + currency.
//   - Destination is a real, public destination (SITE_PAGE must
//     exist, belong to this client, AND be PUBLISHED).
//   - Audience has at least one location (or explicit nationwide).
//   - Age/gender numbers are sane.
//   - Special-category packages enforce housing-restricted
//     constraints: clamp age 18–65, force gender=all, reject
//     postal-code targeting + narrow custom audiences.
//   - Copy linter (ads.compliance.js) blocks risky phrases in
//     headline/primaryText/description.
//   - Special-category packages still need explicit review
//     acknowledgment (unchanged).
//   - Large-budget acknowledgment gate (unchanged).
//
// Called by updatePackage (READY transition) AND by exportPackage
// (defense in depth — never ship a stale READY row that no longer
// satisfies the contract).
export async function validatePackageReady(pkg) {
  const missing = [];

  // ── Creatives ─────────────────────────────────────────────
  if (!pkg.creatives || pkg.creatives.length === 0) {
    missing.push("at least one creative");
  } else {
    for (const c of pkg.creatives) {
      const headline = typeof c.headline === "string" ? c.headline.trim() : "";
      const primaryText = typeof c.primaryText === "string" ? c.primaryText.trim() : "";
      if (!headline) missing.push(`creative #${c.variantIndex ?? "?"} needs a headline`);
      if (!primaryText) missing.push(`creative #${c.variantIndex ?? "?"} needs primary text`);
      if (typeof c.cta === "string" && c.cta.length > 0 && !c.cta.trim()) {
        missing.push(`creative #${c.variantIndex ?? "?"} CTA is whitespace-only`);
      }
    }
  }

  // ── Budget ───────────────────────────────────────────────
  if (!pkg.budget) {
    missing.push("budget");
  } else {
    const daily = Number(pkg.budget.dailyBudgetCents) || 0;
    const total = Number(pkg.budget.totalBudgetCents) || 0;
    if (daily <= 0 && total <= 0) {
      missing.push("budget needs a positive daily or total amount");
    }
    if (!pkg.budget.currency || typeof pkg.budget.currency !== "string") {
      missing.push("budget needs a currency");
    }
    if (pkg.budget.durationDays != null && Number(pkg.budget.durationDays) <= 0) {
      missing.push("budget durationDays must be > 0");
    }
  }

  // ── Destination ──────────────────────────────────────────
  if (!pkg.destination) {
    missing.push("destination");
  } else {
    const d = pkg.destination;
    if (d.kind === "SITE_PAGE") {
      if (!d.sitePageId) {
        missing.push("SITE_PAGE destination needs a sitePageId");
      } else {
        const page = await prisma.sitePage.findFirst({
          where: { id: d.sitePageId, clientId: pkg.clientId },
          select: { id: true, status: true },
        });
        if (!page) {
          missing.push("destination site page not found in this workspace");
        } else if (page.status !== "PUBLISHED") {
          missing.push("destination site page must be PUBLISHED before ready");
        }
      }
    } else if (d.kind === "EXTERNAL_URL") {
      const url = typeof d.externalUrl === "string" ? d.externalUrl.trim() : "";
      if (!url) {
        missing.push("EXTERNAL_URL destination needs a URL");
      } else if (!/^https?:\/\//i.test(url)) {
        missing.push("destination URL must start with http(s)://");
      }
    } else if (d.kind === "SOCIAL_PROFILE") {
      const profile = typeof d.socialProfile === "string" ? d.socialProfile.trim() : "";
      if (!profile) {
        missing.push("SOCIAL_PROFILE destination needs a profile URL or handle");
      }
    } else if (!d.kind) {
      missing.push("destination kind not set");
    }
  }

  // ── Audience ─────────────────────────────────────────────
  if (!pkg.audience) {
    missing.push("audience");
  } else {
    const locations = Array.isArray(pkg.audience.locationsJson)
      ? pkg.audience.locationsJson
      : [];
    if (locations.length === 0) {
      missing.push(
        "audience needs at least one location (use {kind:'country', value:'US'} for nationwide)",
      );
    }
    if (pkg.audience.ageMin != null && pkg.audience.ageMax != null) {
      if (pkg.audience.ageMin > pkg.audience.ageMax) {
        missing.push("audience ageMin cannot be greater than ageMax");
      }
    }
  }

  // ── Compliance + budget acknowledgments (existing behavior) ──
  if (pkg.specialCategory && pkg.specialCategory !== "NONE" && !pkg.reviewedByUserId) {
    missing.push("compliance review acknowledgment");
  }
  const dailyOver = pkg.budget?.dailyBudgetCents && pkg.budget.dailyBudgetCents > 50_000;
  const totalOver = pkg.budget?.totalBudgetCents && pkg.budget.totalBudgetCents > 1_000_000;
  if ((dailyOver || totalOver) && !pkg.reviewedByUserId) {
    missing.push("budget review acknowledgment");
  }

  // ── Special category strict gate ──────────────────────────
  if (pkg.specialCategory === "HOUSING") {
    const audience = pkg.audience;
    if (audience) {
      // Age must be the broad 18–65 window.
      if (audience.ageMin != null && audience.ageMin < 18) {
        missing.push("HOUSING age min must be ≥ 18");
      }
      if (audience.ageMax != null && audience.ageMax > 65) {
        missing.push("HOUSING age max must be ≤ 65");
      }
      // Genders must be all/none.
      const genders = Array.isArray(audience.gendersJson) ? audience.gendersJson : [];
      const onlyAll =
        genders.length === 0 ||
        (genders.length === 1 && (genders[0] === "all" || genders[0] === null));
      if (!onlyAll) missing.push("HOUSING audience genders must be ['all']");
      // No postal/ZIP-only targeting.
      const locations = Array.isArray(audience.locationsJson) ? audience.locationsJson : [];
      const hasPostal = locations.some(
        (l) =>
          l && typeof l === "object" &&
          (l.kind === "postal" || l.kind === "zip" || l.zip || l.postalCode || l.postal_code),
      );
      if (hasPostal) {
        missing.push("HOUSING audience cannot use postal/ZIP targeting");
      }
      // No narrow custom-audience hints. The hint shape carries
      // free-form strings today; reject any non-empty array.
      const hints = Array.isArray(audience.customAudienceHintsJson)
        ? audience.customAudienceHintsJson
        : [];
      if (hints.length > 0) {
        missing.push("HOUSING audience cannot use narrow custom-audience hints");
      }
      // housingRestricted must be true.
      if (!audience.housingRestricted) {
        missing.push("HOUSING audience must have housingRestricted=true");
      }
    }
  }

  if (missing.length > 0) {
    const err = new Error(`Cannot mark ready — ${missing.join("; ")}`);
    err.status = 400;
    err.code = "READY_PRECONDITIONS_FAILED";
    err.missing = missing;
    throw err;
  }

  // ── Copy linter (last — runs after structural checks pass) ──
  const findings = lintCreativeCopy(pkg.creatives ?? [], pkg.specialCategory);
  if (findings.length > 0) {
    const err = new Error(
      `Copy review failed — remove ${findings.length} risky phrase${findings.length === 1 ? "" : "s"} before going live`,
    );
    err.status = 400;
    err.code = "COMPLIANCE_COPY_REVIEW_FAILED";
    err.findings = findings;
    throw err;
  }
}

// ── Creatives ──────────────────────────────────────────────────────────

export async function upsertCreative(clientId, packageId, input) {
  await assertPackageOwned(clientId, packageId);
  // Ads-01 — validate every media-asset id belongs to this
  // workspace before persisting. Atomic: any one cross-workspace id
  // rejects the whole upsert.
  await assertAssetsOwned(clientId, [
    input.primaryAssetId,
    ...(Array.isArray(input.additionalAssetIds) ? input.additionalAssetIds : []),
  ]);
  return prisma.adCreative.upsert({
    where: {
      adPackageId_variantIndex: {
        adPackageId: packageId,
        variantIndex: input.variantIndex,
      },
    },
    create: {
      adPackageId: packageId,
      variantIndex: input.variantIndex,
      channel: input.channel ?? null,
      headline: input.headline,
      primaryText: input.primaryText,
      description: input.description ?? null,
      cta: input.cta ?? null,
      primaryAssetId: input.primaryAssetId ?? null,
      additionalAssetIdsJson: input.additionalAssetIds ?? [],
      rationale: input.rationale ?? null,
    },
    update: {
      channel: input.channel ?? null,
      headline: input.headline,
      primaryText: input.primaryText,
      description: input.description ?? null,
      cta: input.cta ?? null,
      primaryAssetId: input.primaryAssetId ?? null,
      additionalAssetIdsJson: input.additionalAssetIds ?? [],
      rationale: input.rationale ?? null,
    },
  });
}

export async function deleteCreative(clientId, packageId, creativeId) {
  // Ads-01 — scoped delete. The WHERE pins all three: creative id,
  // parent package id, AND the parent package's clientId via a
  // nested filter. A creativeId from another workspace silently
  // matches zero rows even if the caller spoofs a known packageId.
  const result = await prisma.adCreative.deleteMany({
    where: {
      id: creativeId,
      adPackageId: packageId,
      adPackage: { clientId },
    },
  });
  if (result.count === 0) {
    const err = new Error("Creative not found");
    err.status = 404;
    err.code = "CREATIVE_NOT_FOUND";
    throw err;
  }
  return { id: creativeId, deleted: true };
}

// ── Audience ───────────────────────────────────────────────────────────

export async function upsertAudience(clientId, packageId, patch) {
  const pkg = await assertPackageOwned(clientId, packageId, true);
  const housingRestricted = pkg.specialCategory !== "NONE";

  const data = {
    locationsJson: patch.locations ?? undefined,
    interestsJson: patch.interests ?? undefined,
    customAudienceHintsJson: patch.customAudienceHints ?? undefined,
    languagesJson: patch.languages ?? undefined,
    housingRestricted,
  };

  // Demographic targeting is forbidden under Meta's Special Ad
  // Categories. Forcibly clear when the package is housing/
  // employment/credit-tagged so the export bundle is compliant.
  if (housingRestricted) {
    data.ageMin = 18;
    data.ageMax = 65;
    data.gendersJson = ["all"];
  } else {
    if (patch.ageMin !== undefined) data.ageMin = patch.ageMin;
    if (patch.ageMax !== undefined) data.ageMax = patch.ageMax;
    if (patch.genders !== undefined) data.gendersJson = patch.genders;
  }

  return prisma.adAudience.upsert({
    where: { adPackageId: packageId },
    create: { adPackageId: packageId, ...data },
    update: data,
  });
}

// Helper used after a specialCategory flip on an existing audience.
async function applyHousingRestrictedClearing(audienceId) {
  return prisma.adAudience.update({
    where: { id: audienceId },
    data: {
      ageMin: 18,
      ageMax: 65,
      gendersJson: ["all"],
      housingRestricted: true,
    },
  });
}

// ── Budget ─────────────────────────────────────────────────────────────

export async function upsertBudget(clientId, packageId, patch) {
  await assertPackageOwned(clientId, packageId);
  const data = {
    dailyBudgetCents:
      patch.dailyBudgetCents === undefined ? undefined : patch.dailyBudgetCents,
    totalBudgetCents:
      patch.totalBudgetCents === undefined ? undefined : patch.totalBudgetCents,
    currency: patch.currency,
    durationDays: patch.durationDays === undefined ? undefined : patch.durationDays,
    startsAt: patch.startsAt === undefined ? undefined : patch.startsAt ? new Date(patch.startsAt) : null,
    endsAt: patch.endsAt === undefined ? undefined : patch.endsAt ? new Date(patch.endsAt) : null,
  };
  return prisma.adBudget.upsert({
    where: { adPackageId: packageId },
    create: { adPackageId: packageId, ...data },
    update: data,
  });
}

// ── Destination ────────────────────────────────────────────────────────

export async function upsertDestination(clientId, packageId, patch) {
  await assertPackageOwned(clientId, packageId);
  // Discriminated union — clear the other slots so a stale URL
  // never leaks into an export after the kind changed.
  const data = {
    kind: patch.kind,
    sitePageId: patch.kind === "SITE_PAGE" ? patch.sitePageId ?? null : null,
    externalUrl: patch.kind === "EXTERNAL_URL" ? patch.externalUrl ?? null : null,
    socialProfile: patch.kind === "SOCIAL_PROFILE" ? patch.socialProfile ?? null : null,
    utmJson: patch.utm === undefined ? undefined : patch.utm,
    pixelIdsJson: patch.pixelIds === undefined ? undefined : patch.pixelIds,
  };
  return prisma.adDestination.upsert({
    where: { adPackageId: packageId },
    create: { adPackageId: packageId, ...data },
    update: data,
  });
}

// ── Generation ─────────────────────────────────────────────────────────

const GENERATION_SCHEMA = {
  name: "ad_package_generation",
  schema: {
    type: "object",
    properties: {
      creatives: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            headline: { type: "string", minLength: 1, maxLength: 200 },
            primaryText: { type: "string", minLength: 1, maxLength: 2000 },
            description: { type: "string", maxLength: 600 },
            cta: { type: "string", maxLength: 60 },
            rationale: { type: "string", maxLength: 600 },
            channelHint: { type: "string", maxLength: 40 },
          },
          required: ["headline", "primaryText"],
        },
      },
      audience: {
        type: "object",
        properties: {
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["country", "region", "city", "postal"] },
                value: { type: "string", maxLength: 200 },
              },
              required: ["kind", "value"],
            },
          },
          ageMin: { type: "number" },
          ageMax: { type: "number" },
          interests: { type: "array", items: { type: "string", maxLength: 200 } },
          languages: { type: "array", items: { type: "string", maxLength: 8 } },
        },
      },
      budget: {
        type: "object",
        properties: {
          suggestedDailyCents: { type: "number" },
          suggestedTotalCents: { type: "number" },
          durationDays: { type: "number" },
          rationale: { type: "string", maxLength: 600 },
        },
      },
      complianceNotes: { type: "string", maxLength: 1200 },
    },
    required: ["creatives"],
    additionalProperties: false,
  },
  strict: false,
};

export async function generatePackage(clientId, packageId, userId, { tone = "professional", regenerate = "all" } = {}) {
  const pkg = await prisma.adPackage.findFirst({
    where: { id: packageId, clientId },
    include: {
      creatives: { orderBy: { variantIndex: "asc" } },
      audience: true,
      budget: true,
      destination: true,
    },
  });
  if (!pkg) {
    const err = new Error("Ad package not found");
    err.status = 404;
    err.code = "AD_PACKAGE_NOT_FOUND";
    throw err;
  }

  const ctx = await loadClientGenerationContext(clientId);
  const sourceCtx = await loadPackageSourceContext(pkg);

  const systemPrompt = buildSystemPrompt({ ctx, pkg, tone });
  const userPrompt = buildUserPrompt({ pkg, sourceCtx });

  const result = await generateStructuredContent({
    systemPrompt,
    userPrompt,
    taskType: "generation",
    responseFormat: { type: "json_schema", json_schema: GENERATION_SCHEMA },
    temperature: 0.7,
    timeoutMs: 45_000,
  });

  const parsed = result.parsed ?? {};

  // Persist the generation pieces requested by the regenerate flag.
  // 'all' = creatives + audience + budget. Compliance notes always
  // overwrite reviewNotes if returned, so the user sees them in the
  // review step.
  const writeCreatives = regenerate === "all" || regenerate === "creatives";
  const writeAudience = regenerate === "all" || regenerate === "audience";
  const writeBudget = regenerate === "all" || regenerate === "budget";

  if (writeCreatives && Array.isArray(parsed.creatives)) {
    // Clear and re-seed — simpler than reconciling indices and
    // matches the "regenerate the whole set" mental model.
    await prisma.adCreative.deleteMany({ where: { adPackageId: packageId } });
    for (let i = 0; i < Math.min(parsed.creatives.length, 4); i++) {
      const c = parsed.creatives[i];
      await prisma.adCreative.create({
        data: {
          adPackageId: packageId,
          variantIndex: i + 1,
          channel: null,
          headline: truncate(String(c.headline || "").trim(), 400),
          primaryText: truncate(String(c.primaryText || "").trim(), 4000),
          description: c.description ? truncate(String(c.description).trim(), 2000) : null,
          cta: c.cta ? truncate(String(c.cta).trim(), 80) : null,
          rationale: c.rationale ? truncate(String(c.rationale).trim(), 2000) : null,
        },
      });
    }
  }

  if (writeAudience && parsed.audience) {
    await upsertAudience(clientId, packageId, {
      locations: Array.isArray(parsed.audience.locations) ? parsed.audience.locations : undefined,
      ageMin: typeof parsed.audience.ageMin === "number" ? parsed.audience.ageMin : undefined,
      ageMax: typeof parsed.audience.ageMax === "number" ? parsed.audience.ageMax : undefined,
      interests: Array.isArray(parsed.audience.interests) ? parsed.audience.interests : undefined,
      languages: Array.isArray(parsed.audience.languages) ? parsed.audience.languages : undefined,
    });
  }

  if (writeBudget && parsed.budget) {
    const suggestedDaily = typeof parsed.budget.suggestedDailyCents === "number"
      ? Math.max(0, Math.round(parsed.budget.suggestedDailyCents))
      : null;
    const suggestedTotal = typeof parsed.budget.suggestedTotalCents === "number"
      ? Math.max(0, Math.round(parsed.budget.suggestedTotalCents))
      : null;
    await prisma.adBudget.upsert({
      where: { adPackageId: packageId },
      create: {
        adPackageId: packageId,
        // Pre-fill the live budget with the AI suggestion — user
        // can adjust before marking ready.
        dailyBudgetCents: suggestedDaily,
        suggestedDailyBudgetCents: suggestedDaily,
        suggestedTotalBudgetCents: suggestedTotal,
        durationDays:
          typeof parsed.budget.durationDays === "number" ? Math.max(1, Math.round(parsed.budget.durationDays)) : null,
      },
      update: {
        suggestedDailyBudgetCents: suggestedDaily,
        suggestedTotalBudgetCents: suggestedTotal,
      },
    });
  }

  // Stamp generation provenance + compliance notes on the package.
  const updatedReviewNotes =
    typeof parsed.complianceNotes === "string" && parsed.complianceNotes.trim()
      ? parsed.complianceNotes.trim().slice(0, 4000)
      : pkg.reviewNotes;

  await prisma.adPackage.update({
    where: { id: packageId },
    data: {
      generatedByModel: result.model,
      promptTokens: (pkg.promptTokens ?? 0) + (result.usage?.prompt_tokens ?? 0),
      completionTokens: (pkg.completionTokens ?? 0) + (result.usage?.completion_tokens ?? 0),
      reviewNotes: updatedReviewNotes,
    },
  });

  // Lump AI usage under GENERATE_POST until a dedicated enum value lands.
  trackAiUsage({
    userId,
    clientId,
    actionType: "GENERATE_POST",
    model: result.model,
    promptTokens: result.usage?.prompt_tokens ?? 0,
    completionTokens: result.usage?.completion_tokens ?? 0,
    metadata: { source: "ad_package_generate", adPackageId: packageId, regenerate },
  });

  return getPackage(clientId, packageId);
}

// ── Source-context loader (shared by generation + export) ──────────────
//
// Whitelist-only. Mirrors loadAiReplyContext in inbox.service.js so
// the discipline around what gets sent to OpenAI is consistent
// across surfaces.
export async function loadPackageSourceContext(pkg) {
  if (!pkg) return null;
  // Ads-01 — every lookup tenant-scoped via pkg.clientId. Cross-
  // workspace ids return null so the LLM context never sees foreign
  // workspace data.
  switch (pkg.sourceType) {
    case "CAMPAIGN":
      if (!pkg.sourceId) return null;
      return {
        kind: "campaign",
        row: await prisma.campaign.findFirst({
          where: { id: pkg.sourceId, clientId: pkg.clientId },
          select: {
            id: true,
            name: true,
            campaignType: true,
            sourceTitle: true,
            campaignIdea: true,
            status: true,
          },
        }),
      };
    case "SITE_PAGE":
      if (!pkg.sourceId) return null;
      return {
        kind: "site_page",
        row: await prisma.sitePage.findFirst({
          where: { id: pkg.sourceId, clientId: pkg.clientId },
          select: {
            id: true,
            title: true,
            slug: true,
            description: true,
            pageGoal: true,
            blocksJson: true,
            sourceType: true,
            sourceId: true,
          },
        }),
      };
    case "DRAFT":
      if (!pkg.sourceId) return null;
      return {
        kind: "draft",
        row: await prisma.draft.findFirst({
          where: { id: pkg.sourceId, clientId: pkg.clientId },
          select: {
            id: true,
            channel: true,
            body: true,
            hashtags: true,
            cta: true,
          },
        }),
      };
    case "PROPERTY":
    case "CONTENT_ASSET":
      if (!pkg.sourceId) return null;
      return {
        kind: "data_item",
        row: await prisma.workspaceDataItem.findFirst({
          where: { id: pkg.sourceId, clientId: pkg.clientId },
          select: {
            id: true,
            type: true,
            title: true,
            summary: true,
            dataJson: true,
            tags: true,
          },
        }),
      };
    case "IDEA":
      return { kind: "idea", text: pkg.sourceIdea };
    default:
      return null;
  }
}

// ── Prompt builders ────────────────────────────────────────────────────

function buildSystemPrompt({ ctx, pkg, tone }) {
  const brandName = ctx.client?.name ?? "the business";
  const brand = ctx.brand ?? null;
  const voice = ctx.voice ?? null;
  const isHousing = pkg.specialCategory === "HOUSING";

  const lines = [
    `You generate an export-ready ad campaign package for ${brandName}.`,
    `Tone: ${tone}. Output JSON only matching the supplied schema.`,
    `Squadpitch does NOT publish this — the user will export it and run it themselves on Meta Ads Manager / Google Ads / etc., so every recommendation must be platform-agnostic and complete.`,
  ];
  if (brand?.tagline) lines.push(`Brand tagline: ${brand.tagline}`);
  if (brand?.valueProposition) lines.push(`Value proposition: ${brand.valueProposition}`);
  if (voice?.tone) lines.push(`Voice tone: ${voice.tone}`);
  if (voice?.style) lines.push(`Voice style: ${voice.style}`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- Produce 3 distinct creative variants (different angles, not synonym swaps).");
  lines.push("- Headlines: short, specific, action-oriented.");
  lines.push("- Primary text: 1–3 sentences. Concrete benefit + clear next step.");
  lines.push("- CTA: a real CTA label (Learn More / Sign Up / Get Quote / Schedule Tour / etc.).");
  lines.push("- Rationale: 1–2 sentences explaining the angle and who it's for.");
  lines.push("- Audience: realistic, broad enough to spend the suggested budget against.");
  lines.push("- Budget: cents-based, sane for objective and audience size.");
  lines.push("- Never invent facts not provided in the source context.");
  if (isHousing) {
    lines.push(
      "- HOUSING SPECIAL CATEGORY: this package is subject to Fair Housing rules. Do NOT propose demographic targeting (age narrower than 18-65, gender filters, ZIP-only targeting, lookalike audiences based on protected attributes). Do NOT use phrases like 'young professionals', 'family-friendly neighborhood', 'mature buyers', or similar protected-class language. Include a compliance note explaining this.",
    );
  }
  return lines.join("\n");
}

function buildUserPrompt({ pkg, sourceCtx }) {
  const lines = [
    "# Package",
    "",
    `**Name:** ${pkg.name}`,
    `**Objective:** ${pkg.objective}`,
    `**Special category:** ${pkg.specialCategory}`,
  ];
  if (pkg.destination) {
    lines.push(`**Destination kind:** ${pkg.destination.kind}`);
    if (pkg.destination.externalUrl) lines.push(`**Destination URL:** ${pkg.destination.externalUrl}`);
    if (pkg.destination.socialProfile) lines.push(`**Destination profile:** ${pkg.destination.socialProfile}`);
  }

  if (sourceCtx?.row || sourceCtx?.text) {
    lines.push("", `# Source — ${sourceCtx.kind}`);
    const r = sourceCtx.row;
    if (sourceCtx.kind === "campaign" && r) {
      lines.push(`**Name:** ${r.name}`);
      lines.push(`**Type:** ${r.campaignType}`);
      if (r.sourceTitle) lines.push(`**Topic:** ${r.sourceTitle}`);
      if (r.campaignIdea) lines.push(`**Idea:** ${truncate(r.campaignIdea, 600)}`);
    } else if (sourceCtx.kind === "site_page" && r) {
      lines.push(`**Title:** ${r.title}`);
      if (r.pageGoal) lines.push(`**Page goal:** ${r.pageGoal}`);
      if (r.description) lines.push(`**Description:** ${r.description}`);
      const facts = collectBlockFacts(r.blocksJson);
      if (facts.length > 0) {
        lines.push("", "**Facts shown on the page:**");
        for (const f of facts) lines.push(`- ${f}`);
      }
    } else if (sourceCtx.kind === "draft" && r) {
      lines.push(`**Channel:** ${r.channel}`);
      lines.push("**Body:**", truncate(r.body ?? "", 1200));
      if (r.cta) lines.push(`**Existing CTA:** ${r.cta}`);
    } else if (sourceCtx.kind === "data_item" && r) {
      lines.push(`**Type:** ${r.type}`);
      lines.push(`**Title:** ${r.title}`);
      if (r.summary) lines.push(`**Summary:** ${truncate(r.summary, 600)}`);
      const facts = collectDataItemFacts(r.dataJson);
      if (facts.length > 0) {
        lines.push("", "**Known facts (anchor the copy to these):**");
        for (const f of facts) lines.push(`- ${f}`);
      }
    } else if (sourceCtx.kind === "idea" && sourceCtx.text) {
      lines.push("**User-supplied brief:**", truncate(sourceCtx.text, 1200));
    }
  }

  lines.push("");
  lines.push("Generate 3 creative variants, an audience suggestion, a budget suggestion, and a compliance note. JSON only.");
  return lines.join("\n");
}

function collectBlockFacts(blocksJson) {
  if (!Array.isArray(blocksJson)) return [];
  const out = [];
  for (const b of blocksJson) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "hero") {
      if (b.headline) out.push(`Hero: ${truncate(b.headline, 200)}`);
      if (b.subheadline) out.push(`Subheadline: ${truncate(b.subheadline, 200)}`);
    } else if (b.type === "key_details" && Array.isArray(b.items)) {
      for (const item of b.items) {
        if (item?.label && item?.value) out.push(`${item.label}: ${truncate(String(item.value), 160)}`);
      }
    } else if (b.type === "paragraph" && b.body) {
      out.push(`Paragraph: ${truncate(b.body, 320)}`);
    } else if (b.type === "cta" && b.label) {
      out.push(`Existing CTA: ${b.label}`);
    }
  }
  return out;
}

const PROPERTY_FIELDS = [
  ["address", "Address"],
  ["street", "Street"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP"],
  ["price", "Price"],
  ["propertyType", "Property type"],
  ["bedrooms", "Bedrooms"],
  ["bathrooms", "Bathrooms"],
  ["sqft", "Sq ft"],
  ["lotSize", "Lot size"],
  ["yearBuilt", "Year built"],
  ["agentName", "Listing agent"],
  ["brokerage", "Brokerage"],
  ["description", "Description"],
];

function collectDataItemFacts(dataJson) {
  if (!dataJson || typeof dataJson !== "object") return [];
  const facts = [];
  const seen = new Set();
  for (const [k, label] of PROPERTY_FIELDS) {
    const v = dataJson[k];
    if (v === null || v === undefined || v === "") continue;
    facts.push(`${label}: ${truncate(String(v), 320)}`);
    seen.add(k);
  }
  let extras = 0;
  for (const [k, v] of Object.entries(dataJson)) {
    if (seen.has(k)) continue;
    if (extras >= 6) break;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") continue;
    facts.push(`${humanize(k)}: ${truncate(String(v), 200)}`);
    extras += 1;
  }
  return facts;
}

// ── Stats ──────────────────────────────────────────────────────────────

export async function getAdsStats(clientId) {
  const [draftCount, readyCount, exportedCount, totalCount] = await Promise.all([
    prisma.adPackage.count({ where: { clientId, status: "DRAFT" } }),
    prisma.adPackage.count({ where: { clientId, status: "READY" } }),
    prisma.adPackage.count({ where: { clientId, status: "EXPORTED" } }),
    prisma.adPackage.count({ where: { clientId, status: { not: "ARCHIVED" } } }),
  ]);
  return { draftCount, readyCount, exportedCount, totalCount };
}

// ── Helpers ────────────────────────────────────────────────────────────

async function assertPackageOwned(clientId, packageId, withInclude = false) {
  const row = await prisma.adPackage.findFirst({
    where: { id: packageId, clientId },
    ...(withInclude
      ? { include: { creatives: true, audience: true, budget: true, destination: true } }
      : {}),
  });
  if (!row) {
    const err = new Error("Ad package not found");
    err.status = 404;
    err.code = "AD_PACKAGE_NOT_FOUND";
    throw err;
  }
  return row;
}

// Ads-01 — tenant-scoped source lookup for createPackage. Every
// non-IDEA sourceType has a parent table with its own clientId
// column; we check that the source row belongs to the current
// workspace before we let it land on the AdPackage.
//
// Returns the resolved source row (handy for derived fields like
// auto-tagging). Throws SOURCE_NOT_FOUND_OR_FORBIDDEN with a 404
// when the id doesn't exist or belongs to another workspace.
async function assertSourceOwned(clientId, sourceType, sourceId, sourceIdea) {
  if (sourceType === "IDEA") {
    if (!sourceIdea || typeof sourceIdea !== "string" || !sourceIdea.trim()) {
      const err = new Error("IDEA source requires a non-empty sourceIdea");
      err.status = 400;
      err.code = "MISSING_SOURCE_IDEA";
      throw err;
    }
    return null;
  }
  if (!sourceId || typeof sourceId !== "string") {
    const err = new Error(`${sourceType} source requires a sourceId`);
    err.status = 400;
    err.code = "MISSING_SOURCE_ID";
    throw err;
  }

  let row = null;
  switch (sourceType) {
    case "CAMPAIGN":
      row = await prisma.campaign.findFirst({
        where: { id: sourceId, clientId },
        select: { id: true },
      });
      break;
    case "SITE_PAGE":
      row = await prisma.sitePage.findFirst({
        where: { id: sourceId, clientId },
        select: { id: true },
      });
      break;
    case "DRAFT":
      row = await prisma.draft.findFirst({
        where: { id: sourceId, clientId },
        select: { id: true },
      });
      break;
    case "PROPERTY":
      row = await prisma.workspaceDataItem.findFirst({
        where: { id: sourceId, clientId, type: "PROPERTY" },
        select: { id: true },
      });
      break;
    case "CONTENT_ASSET":
      row = await prisma.workspaceDataItem.findFirst({
        where: { id: sourceId, clientId, type: { not: "PROPERTY" } },
        select: { id: true },
      });
      break;
    default: {
      const err = new Error(`Unknown sourceType: ${sourceType}`);
      err.status = 400;
      err.code = "INVALID_SOURCE_TYPE";
      throw err;
    }
  }
  if (!row) {
    const err = new Error(`${sourceType} source not found in this workspace`);
    err.status = 404;
    err.code = "SOURCE_NOT_FOUND_OR_FORBIDDEN";
    throw err;
  }
  return row;
}

// Ads-01 — tenant-scope every media asset id before it lands on a
// creative. Atomic: any one cross-workspace id rejects the whole
// upsert (we never want a creative with a mix of valid + invalid
// asset references).
async function assertAssetsOwned(clientId, assetIds) {
  const ids = Array.from(
    new Set(
      (assetIds ?? []).filter((id) => typeof id === "string" && id.length > 0),
    ),
  );
  if (ids.length === 0) return;
  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: ids }, clientId },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const err = new Error(
      `Media asset(s) not found in this workspace: ${missing.join(", ")}`,
    );
    err.status = 404;
    err.code = "MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN";
    err.missingAssetIds = missing;
    throw err;
  }
}

function truncate(s, max) {
  if (typeof s !== "string") return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function humanize(k) {
  return String(k)
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}
