// Zod schemas for the Squadpitch studio API.

import { z } from "zod";

// ── Enums (mirror Prisma enums) ─────────────────────────────────────────

export const ClientStatusEnum = z.enum([
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
]);

export const ChannelEnum = z.enum([
  "INSTAGRAM",
  "TIKTOK",
  "X",
  "LINKEDIN",
  "FACEBOOK",
  "YOUTUBE",
]);

export const MediaModeEnum = z.enum([
  "BRAND_ASSETS_ONLY",
  "BRAND_ASSETS_PLUS_AI",
  "AI_CHARACTER",
]);

export const DraftKindEnum = z.enum([
  "POST",
  "CAPTION",
  "VIDEO_SCRIPT",
  "CAROUSEL",
  "HOOKS",
  "CTA_VARIANTS",
  "REPLY",
]);

export const DraftStatusEnum = z.enum([
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHED",
  "REJECTED",
  "FAILED",
]);

// ── Client ──────────────────────────────────────────────────────────────

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const CreateClientSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(64).regex(SLUG_PATTERN, {
    message: "slug must be lowercase alphanumeric with dashes",
  }),
  logoUrl: z.string().url().nullable().optional(),
  status: ClientStatusEnum.optional(),
});

export const UpdateClientSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(64).regex(SLUG_PATTERN).optional(),
  logoUrl: z.string().url().nullable().optional(),
  status: ClientStatusEnum.optional(),
});

// ── Brand profile ───────────────────────────────────────────────────────

export const UpsertBrandProfileSchema = z.object({
  description: z.string().max(5000).nullable().optional(),
  industry: z.string().max(200).nullable().optional(),
  audience: z.string().max(5000).nullable().optional(),
  website: z.string().url().max(500).nullable().optional(),
  socialsJson: z.record(z.string(), z.string()).nullable().optional(),
  offers: z.string().max(5000).nullable().optional(),
  competitors: z.string().max(5000).nullable().optional(),
  examplePosts: z
    .array(
      z.object({
        label: z.string().max(120).optional(),
        text: z.string().max(5000),
      })
    )
    .nullable()
    .optional(),
});

// ── Voice profile ───────────────────────────────────────────────────────

export const ContentBucketSchema = z.object({
  key: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(120),
  template: z.string().min(1).max(2000),
});

export const UpsertVoiceProfileSchema = z.object({
  tone: z.string().max(500).nullable().optional(),
  voiceRulesJson: z
    .object({
      do: z.array(z.string().max(500)).default([]),
      dont: z.array(z.string().max(500)).default([]),
    })
    .default({ do: [], dont: [] }),
  bannedPhrases: z.array(z.string().max(200)).default([]),
  ctaPreferences: z.record(z.string(), z.any()).nullable().optional(),
  contentBuckets: z.array(ContentBucketSchema).default([]),
});

// ── Media profile ───────────────────────────────────────────────────────

export const UpsertMediaProfileSchema = z
  .object({
    mode: MediaModeEnum.default("BRAND_ASSETS_ONLY"),
    visualStyle: z.string().max(2000).nullable().optional(),
    assetLibraryJson: z
      .array(
        z.object({
          url: z.string().url(),
          caption: z.string().max(500).optional(),
        })
      )
      .nullable()
      .optional(),
    characterPrompt: z.string().max(5000).nullable().optional(),
    basePromptTemplate: z.string().max(5000).nullable().optional(),
    loraModelUrl: z.string().url().nullable().optional(),
    loraTriggerWord: z.string().max(120).nullable().optional(),
    loraScale: z.number().min(0).max(2).nullable().optional(),
  })
  .refine(
    (data) => {
      if (data.mode === "AI_CHARACTER") {
        return Boolean(data.characterPrompt) && Boolean(data.loraModelUrl);
      }
      return true;
    },
    {
      message:
        "characterPrompt and loraModelUrl are required when mode is AI_CHARACTER",
      path: ["mode"],
    }
  );

// ── Channel settings ────────────────────────────────────────────────────

const ChannelSettingsItemSchema = z.object({
  channel: ChannelEnum,
  isEnabled: z.boolean().default(true),
  maxChars: z.number().int().min(1).max(100000).nullable().optional(),
  allowEmoji: z.boolean().default(true),
  trailingHashtags: z.array(z.string().max(100)).default([]),
  notes: z.string().max(2000).nullable().optional(),
});

export const UpsertChannelSettingsSchema = z.object({
  items: z.array(ChannelSettingsItemSchema).min(1),
});

// ── Generation ──────────────────────────────────────────────────────────

export const GenerateContentSchema = z.object({
  clientId: z.string().min(1),
  kind: DraftKindEnum,
  channel: ChannelEnum,
  bucketKey: z.string().max(40).optional(),
  guidance: z.string().min(1).max(4000),
});

// ── Draft lifecycle ─────────────────────────────────────────────────────

export const UpdateDraftSchema = z.object({
  body: z.string().min(1).max(10000).optional(),
  hooks: z.array(z.string().max(500)).optional(),
  hashtags: z.array(z.string().max(100)).optional(),
  cta: z.string().max(500).nullable().optional(),
  altText: z.string().max(2000).nullable().optional(),
});

export const RejectDraftSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const ScheduleDraftSchema = z.object({
  scheduledFor: z.string().datetime(),
});

// ── List / filter ───────────────────────────────────────────────────────

export const ListDraftsQuerySchema = z.object({
  clientId: z.string().optional(),
  status: DraftStatusEnum.optional(),
  kind: DraftKindEnum.optional(),
  channel: ChannelEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

// ── Media assets ───────────────────────────────────────────────────────

export const MediaAssetSourceEnum = z.enum([
  "UPLOAD",
  "AI_GENERATED",
]);

export const MediaAssetStatusEnum = z.enum([
  "PENDING",
  "GENERATING",
  "READY",
  "FAILED",
]);

export const ListAssetsQuerySchema = z.object({
  clientId: z.string().min(1),
  source: MediaAssetSourceEnum.optional(),
  status: MediaAssetStatusEnum.optional(),
  assetType: z.enum(["image", "video"]).optional(),
  draftId: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const GenerateMediaSchema = z.object({
  clientId: z.string().min(1),
  guidance: z.string().min(1).max(4000),
  draftId: z.string().optional(),
  channel: ChannelEnum.optional(),
  overrides: z
    .object({
      width: z.number().int().min(256).max(2048).optional(),
      height: z.number().int().min(256).max(2048).optional(),
      steps: z.number().int().min(1).max(50).optional(),
      guidanceScale: z.number().min(0).max(20).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
});

export const GenerateVideoSchema = z.object({
  clientId: z.string().min(1),
  guidance: z.string().min(1).max(2000),
  draftId: z.string().optional(),
  channel: ChannelEnum.optional(),
});

export const AttachAssetSchema = z.object({
  draftId: z.string().min(1),
  displayOrder: z.number().int().min(0).optional(),
});

export const LinkAssetSchema = z.object({
  draftId: z.string().min(1),
  role: z.enum(["primary", "thumbnail"]).optional(),
  orderIndex: z.number().int().min(0).optional(),
});

export const GeneratePostFromAssetSchema = z.object({
  kind: DraftKindEnum.default("POST"),
  channel: ChannelEnum,
  guidance: z.string().max(4000).optional(),
});

// ── Post metrics ───────────────────────────────────────────────────────

export const MetricsSummaryQuerySchema = z.object({
  channel: ChannelEnum.optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

// ── Channel connections / OAuth ─────────────────────────────────────────

export const ChannelParamSchema = z.object({
  channel: ChannelEnum,
});

export const OAuthCompleteSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
