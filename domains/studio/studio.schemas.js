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
  industryKey: z.string().max(40).optional(),
});

export const UpdateClientSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(64).regex(SLUG_PATTERN).optional(),
  logoUrl: z.string().url().nullable().optional(),
  status: ClientStatusEnum.optional(),
  industryKey: z.string().max(40).nullable().optional(),
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

// ── Business Data ───────────────────────────────────────────────────────

export const DataItemTypeEnum = z.enum([
  "TESTIMONIAL",
  "CASE_STUDY",
  "PRODUCT_LAUNCH",
  "PROMOTION",
  "STATISTIC",
  "MILESTONE",
  "FAQ",
  "TEAM_SPOTLIGHT",
  "INDUSTRY_NEWS",
  "EVENT",
  "CUSTOM",
]);

export const DataItemStatusEnum = z.enum(["ACTIVE", "ARCHIVED"]);

export const BlueprintCategoryEnum = z.enum([
  "SOCIAL_PROOF",
  "EDUCATION",
  "BEHIND_THE_SCENES",
  "PROMOTION",
  "ENGAGEMENT",
  "STORYTELLING",
  "AUTHORITY",
  "SEASONAL",
]);

export const CreateDataSourceSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["MANUAL"]).default("MANUAL"),
});

export const CreateDataItemSchema = z.object({
  dataSourceId: z.string().optional(),
  type: DataItemTypeEnum,
  title: z.string().min(1).max(200),
  summary: z.string().max(2000).nullable().optional(),
  dataJson: z.record(z.string(), z.any()).default({}),
  tags: z.array(z.string().max(100)).default([]),
  priority: z.number().int().min(0).max(10).default(0),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const UpdateDataItemSchema = z.object({
  type: DataItemTypeEnum.optional(),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(2000).nullable().optional(),
  dataJson: z.record(z.string(), z.any()).optional(),
  tags: z.array(z.string().max(100)).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const ListDataItemsQuerySchema = z.object({
  type: DataItemTypeEnum.optional(),
  status: DataItemStatusEnum.optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ListBlueprintsQuerySchema = z.object({
  category: BlueprintCategoryEnum.optional(),
  applicableType: DataItemTypeEnum.optional(),
  channel: ChannelEnum.optional(),
});

export const ContentOpportunitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  channel: ChannelEnum.optional(),
  type: DataItemTypeEnum.optional(),
});

export const BulkGenerateSchema = z.object({
  items: z
    .array(
      z.object({
        dataItemId: z.string().min(1),
        blueprintId: z.string().min(1),
        channel: ChannelEnum,
        guidance: z.string().max(4000).optional(),
      })
    )
    .min(1)
    .max(20),
});

// ── Data Performance ────────────────────────────────────────────────────

export const DataPerformanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── Generation ──────────────────────────────────────────────────────────

export const GenerateContentSchema = z.object({
  clientId: z.string().min(1),
  kind: DraftKindEnum,
  channel: ChannelEnum,
  bucketKey: z.string().max(40).optional(),
  guidance: z.string().min(1).max(4000),
  templateType: z.string().max(60).optional(),
  dataItemId: z.string().optional(),
  blueprintId: z.string().optional(),
  recommendationId: z.string().max(60).optional(),
});

// ── Draft lifecycle ─────────────────────────────────────────────────────

export const UpdateDraftSchema = z.object({
  body: z.string().min(1).max(10000).optional(),
  hooks: z.array(z.string().max(500)).optional(),
  hashtags: z.array(z.string().max(100)).optional(),
  cta: z.string().max(500).nullable().optional(),
  altText: z.string().max(2000).nullable().optional(),
  channel: ChannelEnum.optional(),
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

// ── Analytics overview ────────────────────────────────────────────────

export const AnalyticsOverviewQuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
});

// ── Channel connections / OAuth ─────────────────────────────────────────

export const ChannelParamSchema = z.object({
  channel: ChannelEnum,
});

export const OAuthCompleteSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

// ── Autopilot ───────────────────────────────────────────────────────────

export const AutopilotPreviewSchema = z.object({
  count: z.number().int().min(1).max(10).default(1),
  channel: ChannelEnum.optional(),
  excludeDataItemIds: z.array(z.string()).default([]),
});

export const AutopilotExecuteSchema = z.object({
  channel: ChannelEnum.optional(),
  autoSchedule: z.boolean().default(false),
  suggestions: z
    .array(
      z.object({
        dataItem: z.object({ id: z.string().min(1) }),
        blueprint: z.object({ id: z.string().min(1) }),
      })
    )
    .min(1)
    .max(10),
});

// ── Data Import ──────────────────────────────────────────────────────────

export const DataSourceTypeEnum = z.enum([
  "URL",
  "CSV",
  "TEXT",
  "GOOGLE_SHEETS",
  "NOTION",
]);

export const ImportFromUrlSchema = z.object({
  url: z.string().url().max(2000),
  hint: z.string().max(500).optional(),
});

export const ImportFromTextSchema = z.object({
  text: z.string().min(10).max(100000),
  hint: z.string().max(500).optional(),
});

export const ImportCSVPreviewSchema = z.object({
  csvContent: z.string().min(5).max(5000000),
});

export const ImportCSVExtractSchema = z.object({
  csvContent: z.string().min(5).max(5000000),
  columnMapping: z.object({
    title: z.string().optional(),
    summary: z.string().optional(),
    type: z.string().optional(),
    tags: z.string().optional(),
    priority: z.string().optional(),
    dataJsonFields: z.array(z.string()).optional(),
  }),
  defaultType: DataItemTypeEnum.optional(),
});

export const ImportFromSheetsSchema = z.object({
  integrationId: z.string().min(1),
  spreadsheetId: z.string().min(1),
  sheetName: z.string().optional(),
  hint: z.string().max(500).optional(),
});

export const ImportFromNotionSchema = z.object({
  integrationId: z.string().min(1),
  hint: z.string().max(500).optional(),
});

// ── Onboarding ──────────────────────────────────────────────────────────

export const OnboardingAnalyzeSchema = z
  .object({
    input: z.string().max(5000).optional().default(""),
    inputType: z.enum(["url", "text"]),
    documentTexts: z.array(z.string().max(200000)).max(5).optional().default([]),
    industryKey: z.string().max(40).optional(),
  })
  .refine(
    (d) => d.input.length >= 3 || (d.documentTexts && d.documentTexts.length > 0),
    { message: "Provide a URL, text description, or at least one document" }
  );

export const ConfirmImportSchema = z.object({
  items: z
    .array(
      z.object({
        type: DataItemTypeEnum,
        title: z.string().min(1).max(200),
        summary: z.string().max(2000).nullable().optional(),
        dataJson: z.record(z.string(), z.any()).optional(),
        tags: z.array(z.string().max(100)).optional(),
        priority: z.number().int().min(0).max(10).optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      })
    )
    .min(1)
    .max(200),
  sourceType: DataSourceTypeEnum,
  sourceUrl: z.string().url().optional(),
});

// ── Tech Stack ────────────────────────────────────────────────────────

export const ListingFeedRefreshSchema = z.object({
  sourceUrl: z.string().url().optional(),
}).optional();

export const ListingFeedSettingsSchema = z.object({
  autoGenerateOnImport: z.boolean(),
});

export const ManualSetupSchema = z.object({
  metadata: z.record(z.string(), z.string().max(2000)).refine(
    (obj) => Object.keys(obj).length > 0,
    { message: "At least one field is required" },
  ),
});

// ── Autopilot ─────────────────────────────────────────────────────────

export const AutopilotSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["off", "draft_assist"]).optional(),
  preferredChannels: z.array(ChannelEnum).max(6).optional(),
  maxDraftsPerWeek: z.number().int().min(1).max(20).optional(),
  maxDraftsPerScheduledRun: z.number().int().min(1).max(5).optional(),
  minimumHoursBetweenDrafts: z.number().int().min(1).max(168).optional(),
  allowListingPosts: z.boolean().optional(),
  allowTestimonialPosts: z.boolean().optional(),
  allowFallbackPosts: z.boolean().optional(),
});

// ── Planner Suggestions ──────────────────────────────────────────────

export const PlannerSuggestionsSchema = z.object({
  weekStart: z.string().min(1),
  weekEnd: z.string().min(1),
});

export const PlanMyWeekSchema = z.object({
  weekStart: z.string().optional(),
  weekEnd: z.string().optional(),
});

export const SwapSuggestionSchema = z.object({
  excludeDataItemIds: z.array(z.string()).default([]),
  targetDate: z.string().min(1),
  channel: ChannelEnum.optional(),
});

// ── Series Builder ──────────────────────────────────────────────────────

export const GenerateSeriesSchema = z.object({
  topic: z.string().min(1).max(200),
  templateId: z.string().min(1),
  parts: z.number().int().min(2).max(7).optional(),
  channel: ChannelEnum,
  kind: z.enum(["POST", "CAPTION", "VIDEO_SCRIPT", "CAROUSEL"]).optional(),
});

// ── Performance Feedback ─────────────────────────────────────────────────

export const RatePerformanceSchema = z.object({
  rating: z.enum(["HIGH", "AVERAGE", "LOW"]),
});

// ── Listing Ingestion ───────────────────────────────────────────────────

export const ManualListingSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  price: z.union([z.string(), z.number()]).optional(),
  status: z.string().max(20).optional(),
  address: z.string().max(200).optional(),
  street: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  zip: z.string().max(20).optional(),
  beds: z.union([z.string(), z.number()]).optional(),
  baths: z.union([z.string(), z.number()]).optional(),
  sqft: z.union([z.string(), z.number()]).optional(),
  lotSize: z.string().max(50).optional(),
  propertyType: z.string().max(50).optional(),
  images: z.union([z.string(), z.array(z.string())]).optional(),
  imageUrl: z.string().max(2000).optional(),
  listingUrl: z.string().max(2000).optional(),
  agentName: z.string().max(100).optional(),
  brokerage: z.string().max(100).optional(),
  yearBuilt: z.union([z.string(), z.number()]).optional(),
  garage: z.union([z.string(), z.number()]).optional(),
  features: z.union([z.string(), z.array(z.string())]).optional(),
});

export const ListingCSVPreviewSchema = z.object({
  csvContent: z.string().min(5).max(5_000_000),
});

export const ListingCSVImportSchema = z.object({
  csvContent: z.string().min(5).max(5_000_000),
  columnMapping: z.record(z.string(), z.string()),
});

export const ListingUrlImportSchema = z.object({
  url: z.string().url().max(2000),
});

export const ListingConfirmUrlSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  price: z.union([z.string(), z.number()]).optional(),
  status: z.string().max(20).optional(),
  address: z.object({
    street: z.string().max(200).optional().nullable(),
    city: z.string().max(100).optional().nullable(),
    state: z.string().max(50).optional().nullable(),
    zip: z.string().max(20).optional().nullable(),
  }).optional(),
  beds: z.union([z.string(), z.number()]).optional().nullable(),
  baths: z.union([z.string(), z.number()]).optional().nullable(),
  sqft: z.union([z.string(), z.number()]).optional().nullable(),
  lotSize: z.string().max(50).optional().nullable(),
  propertyType: z.string().max(50).optional().nullable(),
  images: z.array(z.string()).optional(),
  listingUrl: z.string().max(2000).optional().nullable(),
  agentName: z.string().max(100).optional().nullable(),
  brokerage: z.string().max(100).optional().nullable(),
  yearBuilt: z.union([z.string(), z.number()]).optional().nullable(),
  garage: z.union([z.string(), z.number()]).optional().nullable(),
  features: z.union([z.string(), z.array(z.string())]).optional().nullable(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional().nullable(),
});

// ── GBP Integration ─────────────────────────────────────────────────────

export const GBPCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const GBPSetLocationSchema = z.object({
  accountId: z.string().min(1),
  locationId: z.string().min(1),
  locationName: z.string().optional(),
});

// ── CRM Integration ─────────────────────────────────────────────────────

export const CRMConnectSchema = z.object({
  apiKey: z.string().min(1).max(500),
});

export const CRMDisconnectSchema = z.object({});

// ── Listing Feeds ──────────────────────────────────────────────────────

export const CreateListingSourceSchema = z.object({
  name: z.string().max(100).optional(),
  type: z.enum(["URL", "CSV", "MANUAL"]),
  sourceUrl: z.string().url().max(2000).optional(),
});

export const UpdateListingSourceSchema = z.object({
  name: z.string().max(100).optional(),
  sourceUrl: z.string().url().max(2000).optional(),
  isEnabled: z.boolean().optional(),
});
