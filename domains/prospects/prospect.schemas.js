import { z } from "zod";

const optionalUrl = z.string().url().max(2048).optional().or(z.literal(""));
const ProspectChannelSchema = z.enum(["INSTAGRAM", "FACEBOOK", "LINKEDIN"]);

export const CreateProspectSchema = z.object({
  prospectName: z.string().trim().min(1).max(160),
  prospectEmail: z.string().trim().email().max(320),
  businessName: z.string().trim().min(1).max(200),
  industryKey: z.enum(["real_estate", "car_sales"]),
  websiteUrl: optionalUrl,
  sourceUrl: optionalUrl,
  acquisitionSource: z.string().trim().max(120).optional(),
  operatorNote: z.string().trim().max(2000).optional(),
  claimTtlDays: z.number().int().min(1).max(90).optional(),
  selectedChannels: z.array(ProspectChannelSchema).min(1).max(3).optional(),
});

export const ProspectListQuerySchema = z.object({
  status: z.enum(["CLAIMABLE", "CLAIMED", "REVOKED", "EXPIRED"]).optional(),
  search: z.string().trim().max(200).optional(),
});

export const PopulateProspectSchema = z.object({
  listing: z.object({
    title: z.string().trim().min(1).max(240),
    summary: z.string().trim().max(3000).optional(),
    imageUrl: optionalUrl,
    sourceUrl: optionalUrl,
  }).optional(),
  posts: z.array(z.object({
    channel: z.enum(["FACEBOOK", "INSTAGRAM", "LINKEDIN", "LINKEDIN_ORGANIZATION_PAGE", "THREADS", "X", "PINTEREST", "TIKTOK", "YOUTUBE", "GOOGLE_BUSINESS_PROFILE"]),
    body: z.string().trim().min(1).max(10000),
    mediaUrl: optionalUrl,
  })).max(6).default([]),
}).refine((value) => value.listing || value.posts.length > 0, "A listing or sample post is required");

export const PrepareProspectSchema = z.object({
  sourceUrl: optionalUrl,
  selectedChannels: z.array(ProspectChannelSchema).min(1).max(3).optional(),
}).default({});

export const UpdateProspectPreviewSchema = z.object({
  items: z.array(z.discriminatedUnion("itemType", [
    z.object({ itemType: z.literal("DATA_ITEM"), id: z.string().cuid() }),
    z.object({ itemType: z.literal("DRAFT"), id: z.string().cuid() }),
  ])).max(12).refine(
    (items) => new Set(items.map((item) => `${item.itemType}:${item.id}`)).size === items.length,
    "Preview items must be unique",
  ),
});
