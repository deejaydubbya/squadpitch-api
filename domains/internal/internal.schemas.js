// Zod schemas for /api/v1/internal/* mutating endpoints.
//
// Each schema is intentionally narrow: it lists only the fields that the
// route is allowed to set. Anything else in `req.body` is silently
// dropped by `z.object()` (Zod's default), so an admin cannot smuggle a
// `userId`, `id`, `createdAt`, or other protected column through.
//
// Routes call `safeParse(req.body)` and feed the parsed `.data` (not
// `req.body`) into the service layer.

import { z } from "zod";

// ── Common primitives ──────────────────────────────────────────────────

const ID_PATTERN = /^[a-z0-9_-]+$/i; // cuid-friendly
const SLUG_PATTERN = /^[a-z0-9_-]+$/;

const isoOrDateLike = z
  .string()
  .min(1)
  .max(40)
  .nullable()
  .optional();

// ── External services (vendor registry) ────────────────────────────────

const ServiceCategoryEnum = z.enum([
  "ai",
  "infrastructure",
  "auth",
  "billing",
  "messaging",
  "data",
]);
const ServiceStatusEnum = z.enum([
  "healthy",
  "watch",
  "near_limit",
  "critical",
  "down",
]);
const ServiceCriticalityEnum = z.enum([
  "critical",
  "high",
  "standard",
  "low",
]);
const ServiceEnvEnum = z.enum(["production", "staging", "development"]);
const ServiceUsageSourceEnum = z.enum(["manual", "api", "derived"]);

export const CreateExternalServiceSchema = z.object({
  key: z.string().min(1).max(60).regex(SLUG_PATTERN),
  name: z.string().min(1).max(120),
  category: ServiceCategoryEnum,
  purpose: z.string().min(1).max(2000),
  status: ServiceStatusEnum.optional(),
  criticality: ServiceCriticalityEnum.optional(),
  environment: ServiceEnvEnum.optional(),
  consoleUrl: z.string().url().max(500).nullable().optional(),
  docsUrl: z.string().url().max(500).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  usedByFeatures: z.string().max(2000).nullable().optional(),
  recoveryNotes: z.string().max(4000).nullable().optional(),
  fallbackInfo: z.string().max(2000).nullable().optional(),
  planName: z.string().max(120).nullable().optional(),
  billingCycle: z.string().max(40).nullable().optional(),
  renewalDate: isoOrDateLike,
  monthlyCostCents: z.number().int().nonnegative().nullable().optional(),
  hardLimit: z.number().nonnegative().nullable().optional(),
  softLimit: z.number().nonnegative().nullable().optional(),
  currentUsage: z.number().nonnegative().nullable().optional(),
  usageUnit: z.string().max(40).nullable().optional(),
  usageSource: ServiceUsageSourceEnum.optional(),
  isActive: z.boolean().optional(),
});

export const UpdateExternalServiceSchema = CreateExternalServiceSchema
  .partial()
  // Don't allow flipping the key on update — that's the natural ID.
  .omit({ key: true });

export const ExternalServiceUsageSnapshotSchema = z.object({
  usage: z.number().nonnegative(),
  limit: z.number().nonnegative().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  source: ServiceUsageSourceEnum.optional(),
});

// ── Beta testers ───────────────────────────────────────────────────────

const BetaTesterStatusEnum = z.enum(["active", "invited", "paused", "churned"]);
const BetaPriorityEnum = z.enum(["high", "normal", "low"]);

export const CreateBetaTesterSchema = z.object({
  userId: z.string().min(1).max(120),
  email: z.string().email().max(254),
  name: z.string().max(200).nullable().optional(),
  workspaceId: z.string().min(1).max(80).nullable().optional(),
  status: BetaTesterStatusEnum.optional(),
  cohort: z.string().max(60).nullable().optional(),
  tags: z.array(z.string().max(40)).max(50).optional(),
  priority: BetaPriorityEnum.optional(),
  notes: z.string().max(4000).nullable().optional(),
  contactNotes: z.string().max(4000).nullable().optional(),
});

// PATCH cannot change the userId or email (those are identity).
export const UpdateBetaTesterSchema = CreateBetaTesterSchema
  .partial()
  .omit({ userId: true });

// ── Beta feedback ──────────────────────────────────────────────────────

const FeedbackTypeEnum = z.enum([
  "bug",
  "feature_request",
  "ux_issue",
  "general",
  "praise",
  "question",
]);
const FeedbackSeverityEnum = z.enum(["critical", "high", "medium", "low"]);
const FeedbackStatusEnum = z.enum([
  "new",
  "triaged",
  "in_progress",
  "resolved",
  "wont_fix",
  "duplicate",
]);

export const CreateBetaFeedbackSchema = z.object({
  testerId: z.string().min(1).max(80).nullable().optional(),
  // userId is filled from the JWT in the route handler if the body omits it;
  // accept it here for cases where the admin submits on behalf of a user.
  userId: z.string().min(1).max(120).optional(),
  workspaceId: z.string().min(1).max(80).nullable().optional(),
  type: FeedbackTypeEnum.optional(),
  severity: FeedbackSeverityEnum.optional(),
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  route: z.string().max(500).nullable().optional(),
  screenshotUrl: z.string().url().max(2000).nullable().optional(),
  relatedEntityType: z.string().max(60).nullable().optional(),
  relatedEntityId: z.string().max(80).nullable().optional(),
  needsFollowUp: z.boolean().optional(),
});

// Triage: only the moderation surface. resolvedAt is set automatically by
// the service when status flips to a closed value.
export const UpdateBetaFeedbackSchema = z.object({
  status: FeedbackStatusEnum.optional(),
  severity: FeedbackSeverityEnum.optional(),
  type: FeedbackTypeEnum.optional(),
  needsFollowUp: z.boolean().optional(),
  assignee: z.string().max(120).nullable().optional(),
  internalNotes: z.string().max(4000).nullable().optional(),
});

// ── Feature flags ──────────────────────────────────────────────────────

const FlagCategoryEnum = z.enum(["feature", "rollout", "ops", "experiment"]);
const FlagScopeEnum = z.enum(["global", "targeted"]);
const FlagTargetTypeEnum = z.enum(["workspace", "user", "cohort"]);

export const CreateFeatureFlagSchema = z
  .object({
    key: z.string().min(1).max(80).regex(SLUG_PATTERN, {
      message: "key must be lowercase alphanumeric with - or _",
    }),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    category: FlagCategoryEnum.optional(),
    enabled: z.boolean().optional(),
    scope: FlagScopeEnum.optional(),
    targetType: FlagTargetTypeEnum.nullable().optional(),
    targetIds: z.array(z.string().max(120)).max(500).optional(),
    rolloutPercentage: z.number().int().min(0).max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (v) => v.scope !== "targeted" || (v.targetType && (v.targetIds?.length ?? 0) > 0),
    {
      message: "targeted scope requires targetType and at least one targetId",
      path: ["targetIds"],
    }
  );

export const UpdateFeatureFlagSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: FlagCategoryEnum.optional(),
  enabled: z.boolean().optional(),
  scope: FlagScopeEnum.optional(),
  targetType: FlagTargetTypeEnum.nullable().optional(),
  targetIds: z.array(z.string().max(120)).max(500).optional(),
  rolloutPercentage: z.number().int().min(0).max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const ToggleFeatureFlagSchema = z.object({
  enabled: z.boolean(),
});

// ── Webhook admin (toggle is currently inline; promoted to Zod) ───────

export const ToggleWebhookEndpointSchema = z.object({
  isActive: z.boolean(),
});

// ── Path-param validators ─────────────────────────────────────────────

// Most routes use cuid-style params; reject anything that isn't a clean id.
export const IdParamSchema = z.object({
  id: z.string().min(1).max(80).regex(ID_PATTERN, { message: "invalid id" }),
});
