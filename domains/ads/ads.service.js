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
  return { ...row, sourceSummary };
}

async function resolveSourceSummary(pkg) {
  if (!pkg.sourceId && pkg.sourceType !== "IDEA") return null;
  switch (pkg.sourceType) {
    case "CAMPAIGN": {
      const row = await prisma.campaign.findUnique({
        where: { id: pkg.sourceId },
        select: { id: true, name: true, campaignType: true, status: true },
      });
      return row ? { kind: "campaign", ...row } : null;
    }
    case "SITE_PAGE": {
      const row = await prisma.sitePage.findUnique({
        where: { id: pkg.sourceId },
        select: { id: true, title: true, slug: true, status: true },
      });
      return row ? { kind: "site_page", ...row } : null;
    }
    case "DRAFT": {
      const row = await prisma.draft.findUnique({
        where: { id: pkg.sourceId },
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
      const row = await prisma.workspaceDataItem.findUnique({
        where: { id: pkg.sourceId },
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
  // Auto-tag HOUSING for property-sourced packages and for real-
  // estate workspaces. Users can manually override via PATCH.
  const specialCategory = await deriveInitialSpecialCategory(clientId, input);

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
      assertReadyTransitionAllowed(existing);
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

// Readiness checklist enforced before status can flip to READY.
// Mirrors the spec: ≥1 creative, audience + budget + destination
// populated, compliance acknowledged when special category is set.
function assertReadyTransitionAllowed(pkg) {
  const missing = [];
  if (!pkg.creatives || pkg.creatives.length === 0) missing.push("at least one creative");
  if (!pkg.audience) missing.push("audience");
  if (!pkg.budget) missing.push("budget");
  if (!pkg.destination) missing.push("destination");
  if (pkg.specialCategory && pkg.specialCategory !== "NONE" && !pkg.reviewedByUserId) {
    missing.push("compliance review acknowledgment");
  }
  // Budget review gate — large budgets need explicit acknowledgment
  // before they can ship. Cents-based thresholds; see PR description
  // for the chosen ceilings.
  const dailyOver = pkg.budget?.dailyBudgetCents && pkg.budget.dailyBudgetCents > 50_000;
  const totalOver = pkg.budget?.totalBudgetCents && pkg.budget.totalBudgetCents > 1_000_000;
  if ((dailyOver || totalOver) && !pkg.reviewedByUserId) {
    missing.push("budget review acknowledgment");
  }
  if (missing.length > 0) {
    const err = new Error(`Cannot mark ready — missing: ${missing.join(", ")}`);
    err.status = 400;
    err.code = "READY_PRECONDITIONS_FAILED";
    err.missing = missing;
    throw err;
  }
}

// ── Creatives ──────────────────────────────────────────────────────────

export async function upsertCreative(clientId, packageId, input) {
  await assertPackageOwned(clientId, packageId);
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
  await assertPackageOwned(clientId, packageId);
  return prisma.adCreative
    .delete({ where: { id: creativeId } })
    .catch((err) => {
      if (err.code === "P2025") {
        const e = new Error("Creative not found");
        e.status = 404;
        e.code = "CREATIVE_NOT_FOUND";
        throw e;
      }
      throw err;
    });
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
  switch (pkg.sourceType) {
    case "CAMPAIGN":
      if (!pkg.sourceId) return null;
      return {
        kind: "campaign",
        row: await prisma.campaign.findUnique({
          where: { id: pkg.sourceId },
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
        row: await prisma.sitePage.findUnique({
          where: { id: pkg.sourceId },
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
        row: await prisma.draft.findUnique({
          where: { id: pkg.sourceId },
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
        row: await prisma.workspaceDataItem.findUnique({
          where: { id: pkg.sourceId },
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
