// Zod schemas for the AI Content Assistant session state and validation.

import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────────

export const AssistantModeEnum = z.enum(["campaign", "quick_post"]);

export const AssistantCampaignTypeEnum = z.enum([
  "just_listed",
  "open_house",
  "price_drop",
  "general_promotion",
]);

export const ScheduleModeEnum = z.enum(["ai_proposed", "manual"]);

export const StepIdEnum = z.enum([
  "mode_select",
  "property_select",
  "campaign_config",
  "media_select",
  "schedule_review",
  "generate",
]);

// ── Schedule Slot ────────────────────────────────────────────────────────

const ScheduleSlotSchema = z.object({
  channel: z.string(),
  campaignDay: z.number().int().positive(),
  label: z.string().optional(),
  slotType: z.string().optional(),
  angle: z.string().optional(),
});

// ── Session State ────────────────────────────────────────────────────────

export const AssistantSessionSchema = z.object({
  mode: AssistantModeEnum.nullable(),
  // industry-01 — was `.default("real_estate")` which silently
  // forced every assistant session into real-estate behavior even
  // when the workspace's Client.industryKey was null or a
  // different industry. Now nullable so no-industry workspaces
  // round-trip correctly; the FE resolves the real industryKey
  // from the workspace before rendering any industry-specific UI.
  industryKey: z.string().nullable().optional(),
  workspaceId: z.string().nullable(),

  // Property selection
  selectedPropertyId: z.string().nullable(),
  propertyData: z.record(z.unknown()).nullable(),

  // Campaign configuration
  campaignType: AssistantCampaignTypeEnum.nullable(),
  channels: z.array(z.string()).default([]),
  scheduleMode: ScheduleModeEnum.default("ai_proposed"),
  slots: z.array(ScheduleSlotSchema).default([]),

  // Media
  selectedMediaIds: z.array(z.string()).default([]),

  // Quick post specifics
  quickPostChannel: z.string().nullable(),
  quickPostGuidance: z.string().nullable(),
  quickPostKind: z.string().default("POST"),

  // Generation state (tracked for contract building, not UI navigation)
  generationResult: z.unknown().nullable(),
});

// ── Generation Input ─────────────────────────────────────────────────────

export const AssistantGenerationInputSchema = z.object({
  mode: AssistantModeEnum,
  workspaceId: z.string(),
  propertyData: z.record(z.unknown()),
  campaignType: AssistantCampaignTypeEnum,
  channels: z.array(z.string()).min(1),
  slots: z.array(ScheduleSlotSchema).optional(),
  mediaAssetIds: z.array(z.string()).optional(),
  imageContext: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .optional(),
});
