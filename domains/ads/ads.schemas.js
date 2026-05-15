// Zod schemas for the authenticated SquadAds API.

import { z } from "zod";

export const AdObjectiveEnum = z.enum([
  "AWARENESS",
  "TRAFFIC",
  "LEADS",
  "ENGAGEMENT",
  "EVENT",
]);

export const AdPackageStatusEnum = z.enum([
  "DRAFT",
  "READY",
  "EXPORTED",
  "ARCHIVED",
]);

export const AdSpecialCategoryEnum = z.enum([
  "NONE",
  "HOUSING",
  "EMPLOYMENT",
  "CREDIT",
  "SOCIAL_ISSUES",
]);

export const AdDestinationKindEnum = z.enum([
  "SITE_PAGE",
  "EXTERNAL_URL",
  "SOCIAL_PROFILE",
]);

export const AdSourceTypeEnum = z.enum([
  "CAMPAIGN",
  "SITE_PAGE",
  "DRAFT",
  "PROPERTY",
  "CONTENT_ASSET",
  "IDEA",
]);

// ── List ────────────────────────────────────────────────────────────

export const ListPackagesQuerySchema = z.object({
  status: AdPackageStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().max(64).optional(),
});

// ── Create ──────────────────────────────────────────────────────────

export const CreatePackageSchema = z
  .object({
    name: z.string().min(1).max(200),
    objective: AdObjectiveEnum,
    sourceType: AdSourceTypeEnum,
    sourceId: z.string().max(64).optional().nullable(),
    sourceIdea: z.string().max(4000).optional().nullable(),
    // Optional destination hint — most users pick at the wizard
    // stage and patch the destination later, but allowing it here
    // saves a round trip for "promote this SitePage" flows.
    destination: z
      .object({
        kind: AdDestinationKindEnum,
        sitePageId: z.string().max(64).optional().nullable(),
        externalUrl: z.string().url().max(2000).optional().nullable(),
        socialProfile: z.string().max(200).optional().nullable(),
      })
      .optional(),
  })
  .refine((v) => v.sourceType !== "IDEA" || (v.sourceIdea && v.sourceIdea.trim().length > 0), {
    message: "sourceIdea is required when sourceType is IDEA",
    path: ["sourceIdea"],
  })
  .refine((v) => v.sourceType === "IDEA" || Boolean(v.sourceId), {
    message: "sourceId is required for non-IDEA source types",
    path: ["sourceId"],
  });

// ── Patch ───────────────────────────────────────────────────────────

export const UpdatePackageSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    // Status transitions enforced in the service. The client can
    // request DRAFT/READY/ARCHIVED; EXPORTED is service-managed.
    status: z.enum(["DRAFT", "READY", "ARCHIVED"]).optional(),
    specialCategory: AdSpecialCategoryEnum.optional(),
    reviewNotes: z.string().max(4000).nullable().optional(),
    // Set to true to acknowledge the compliance/budget review.
    // The service stamps reviewedByUserId/reviewedAt server-side.
    acknowledgeReview: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

// ── Generate ────────────────────────────────────────────────────────

export const GenerateRequestSchema = z.object({
  tone: z.enum(["professional", "friendly", "concise"]).optional().default("professional"),
  // Which sections to regenerate. Default 'all' on the first
  // generation; subsequent calls can target one section.
  regenerate: z
    .enum(["creatives", "audience", "budget", "all"])
    .optional()
    .default("all"),
});

// ── Creative CRUD ───────────────────────────────────────────────────

export const UpsertCreativeSchema = z.object({
  variantIndex: z.number().int().min(1).max(20),
  channel: z
    .enum([
      "INSTAGRAM",
      "TIKTOK",
      "X",
      "LINKEDIN",
      "LINKEDIN_ORGANIZATION_PAGE",
      "FACEBOOK",
      "YOUTUBE",
      "PINTEREST",
      "THREADS",
    ])
    .nullable()
    .optional(),
  headline: z.string().min(1).max(400),
  primaryText: z.string().min(1).max(4000),
  description: z.string().max(2000).nullable().optional(),
  cta: z.string().max(80).nullable().optional(),
  primaryAssetId: z.string().max(64).nullable().optional(),
  additionalAssetIds: z.array(z.string().max(64)).max(20).optional().default([]),
  rationale: z.string().max(2000).nullable().optional(),
});

// ── Audience ────────────────────────────────────────────────────────

export const AudiencePatchSchema = z.object({
  locations: z
    .array(
      z.object({
        kind: z.enum(["country", "region", "city", "postal"]),
        value: z.string().min(1).max(200),
      }),
    )
    .max(50)
    .optional(),
  ageMin: z.number().int().min(13).max(100).nullable().optional(),
  ageMax: z.number().int().min(13).max(100).nullable().optional(),
  genders: z.array(z.enum(["male", "female", "all"])).max(3).optional(),
  interests: z.array(z.string().min(1).max(200)).max(50).optional(),
  customAudienceHints: z
    .array(
      z.object({
        kind: z.enum(["lookalike", "retargeting", "engaged_recent", "custom"]),
        description: z.string().min(1).max(500),
      }),
    )
    .max(20)
    .optional(),
  languages: z.array(z.string().min(2).max(8)).max(20).optional(),
});

// ── Budget ──────────────────────────────────────────────────────────

export const BudgetPatchSchema = z
  .object({
    dailyBudgetCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
    totalBudgetCents: z.number().int().min(0).max(10_000_000_00).nullable().optional(),
    currency: z.string().length(3).optional(),
    durationDays: z.number().int().min(1).max(365).nullable().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
  })
  .refine(
    (v) =>
      v.dailyBudgetCents === undefined ||
      v.totalBudgetCents === undefined ||
      v.dailyBudgetCents === null ||
      v.totalBudgetCents === null,
    {
      message: "Provide either dailyBudgetCents or totalBudgetCents, not both",
    },
  );

// ── Destination ─────────────────────────────────────────────────────

export const DestinationPatchSchema = z.object({
  kind: AdDestinationKindEnum,
  sitePageId: z.string().max(64).nullable().optional(),
  externalUrl: z.string().url().max(2000).nullable().optional(),
  socialProfile: z.string().max(200).nullable().optional(),
  utm: z
    .object({
      source: z.string().max(80).nullable().optional(),
      medium: z.string().max(80).nullable().optional(),
      campaign: z.string().max(160).nullable().optional(),
      content: z.string().max(160).nullable().optional(),
      term: z.string().max(80).nullable().optional(),
    })
    .nullable()
    .optional(),
  pixelIds: z.array(z.string().max(80)).max(10).optional(),
});

// ── Export ──────────────────────────────────────────────────────────

export const ExportRequestSchema = z.object({
  format: z.enum(["json", "markdown"]).optional().default("json"),
});
