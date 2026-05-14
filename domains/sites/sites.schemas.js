// Zod schemas for the authenticated SquadSites dashboard API.
//
// These are workspace-owner-only routes; the body shapes here are
// stricter than the public /resolve payload because the dashboard
// writes back into the database. Block + form-field shapes match
// what the public runtime expects to render.

import { z } from "zod";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,127}[a-z0-9])?$/;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

// IMPORTANT: these mirror the Prisma enums in schema.prisma. Keep
// values in sync — Postgres will reject unknown enum values at
// write time, which would 500 the API. The Phase B migration
// created the canonical names below; an earlier Phase C revision
// of this file accidentally used ARCHIVED / RESOLVED, which would
// have crashed the first real status transition.
export const SiteStatusEnum = z.enum(["DRAFT", "PUBLISHED", "UNPUBLISHED", "ARCHIVED"]);
export const PageStatusEnum = z.enum(["DRAFT", "PUBLISHED", "UNPUBLISHED", "ARCHIVED"]);
export const SubmissionStatusEnum = z.enum(["NEW", "PROCESSED", "SPAM"]);

// New in plan 02 of the SquadSites MVP — source-aware metadata.
export const SiteSourceTypeEnum = z.enum([
  "CAMPAIGN",
  "PROPERTY",
  "DATA_ITEM",
  "IDEA",
]);
export const SitePageGoalEnum = z.enum([
  "LEAD_CAPTURE",
  "LISTING",
  "OFFER",
  "EVENT",
  "CONSULTATION",
]);

// ── Blocks ──────────────────────────────────────────────────────────────
//
// Block shape is intentionally permissive on a per-block basis so the
// dashboard can roll out new block types ahead of the runtime catching
// up. The runtime block-renderer silently skips unknown block types.

const HeroBlockSchema = z.object({
  type: z.literal("hero"),
  headline: z.string().max(240).optional().default(""),
  subheadline: z.string().max(600).optional().default(""),
  imageId: z.string().max(128).optional(),
  imageUrl: z.string().url().optional(),
});

const ParagraphBlockSchema = z.object({
  type: z.literal("paragraph"),
  body: z.string().max(4000).optional().default(""),
});

const ImageBlockSchema = z.object({
  type: z.literal("image"),
  imageId: z.string().max(128).optional(),
  imageUrl: z.string().url().optional(),
  alt: z.string().max(240).optional().default(""),
  caption: z.string().max(400).optional().default(""),
});

const CtaBlockSchema = z.object({
  type: z.literal("cta"),
  label: z.string().max(120),
  // Permissive enough to cover the realistic landing-page CTA
  // shapes: absolute URLs (https://...), relative paths
  // (/contact), and same-page anchors (#lead-form). Strict
  // .url() validation would reject the last two — but those
  // are the more common CTA targets on a single-page landing
  // page. We still hard-block javascript:/data:/vbscript:/file:
  // schemes since rendered <a href> with one of those is an
  // XSS surface.
  href: z
    .string()
    .min(1)
    .max(2000)
    .refine((v) => !/^\s*(javascript|data|vbscript|file):/i.test(v), {
      message: "CTA href cannot use javascript:, data:, vbscript:, or file: schemes",
    }),
});

const LeadFormBlockSchema = z.object({
  type: z.literal("lead_form"),
  formId: z.string().min(1).max(64),
});

// Plan 03 — section/block expansion to cover the SquadSites MVP
// section list (gallery, details, testimonial, FAQ, contact).
// Each block's fields are length-capped + array-bounded to keep
// the runtime renderer's surface predictable and the dashboard
// generation prompt budget small.

const GalleryBlockSchema = z.object({
  type: z.literal("gallery"),
  imageUrls: z.array(z.string().url()).min(1).max(20),
  layout: z.enum(["grid", "carousel"]).optional().default("grid"),
});

const KeyDetailsBlockSchema = z.object({
  type: z.literal("key_details"),
  heading: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        value: z.string().min(1).max(240),
      }),
    )
    .min(1)
    .max(20),
});

const TestimonialBlockSchema = z.object({
  type: z.literal("testimonial"),
  quote: z.string().min(1).max(800),
  author: z.string().max(120).optional(),
  role: z.string().max(120).optional(),
  imageUrl: z.string().url().optional(),
});

const FaqBlockSchema = z.object({
  type: z.literal("faq"),
  heading: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        question: z.string().min(1).max(240),
        answer: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20),
});

const ContactBlockSchema = z.object({
  type: z.literal("contact"),
  heading: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  address: z.string().max(400).optional(),
  socials: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        url: z.string().url(),
      }),
    )
    .max(10)
    .optional(),
});

const BlockSchema = z.discriminatedUnion("type", [
  HeroBlockSchema,
  ParagraphBlockSchema,
  ImageBlockSchema,
  CtaBlockSchema,
  LeadFormBlockSchema,
  GalleryBlockSchema,
  KeyDetailsBlockSchema,
  TestimonialBlockSchema,
  FaqBlockSchema,
  ContactBlockSchema,
]);

// ── Form field defs ─────────────────────────────────────────────────────

const FormFieldTypeEnum = z.enum([
  "text",
  "email",
  "phone",
  "textarea",
  "select",
  "checkbox",
]);

const FormFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_PATTERN, {
      message: "key must start with a letter and contain only lowercase letters, digits, underscores",
    }),
    label: z.string().min(1).max(120),
    type: FormFieldTypeEnum,
    required: z.boolean().optional().default(false),
    placeholder: z.string().max(120).optional(),
    options: z
      .array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(120) }))
      .max(50)
      .optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "select fields require at least one option",
        path: ["options"],
      });
    }
  });

const SuccessActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: z.string().min(1).max(400) }),
  z.object({ type: z.literal("redirect"), url: z.string().url() }),
]);

// ── Site ────────────────────────────────────────────────────────────────

export const UpdateSiteSchema = z.object({
  status: SiteStatusEnum.optional(),
  themeJson: z
    .object({
      accent: z.string().max(32).optional(),
      bg: z.string().max(32).optional(),
      fontFamily: z.string().max(80).optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  faviconUrl: z.string().url().nullable().optional(),
  ogDefaultImageId: z.string().max(128).nullable().optional(),
});

// ── SitePage ────────────────────────────────────────────────────────────

export const CreatePageSchema = z.object({
  slug: z.string().min(1).max(128).regex(SLUG_PATTERN, {
    message: "slug must be lowercase alphanumeric with dashes",
  }),
  title: z.string().min(1).max(200),
  description: z.string().max(400).optional(),
  blocksJson: z.array(BlockSchema).max(80).optional().default([]),
  campaignId: z.string().max(64).nullable().optional(),
  sourceType: SiteSourceTypeEnum.nullable().optional(),
  sourceId: z.string().max(64).nullable().optional(),
  pageGoal: SitePageGoalEnum.nullable().optional(),
  noIndex: z.boolean().optional(),
  heroImageId: z.string().max(128).nullable().optional(),
  seoTitle: z.string().max(160).nullable().optional(),
  seoDescription: z.string().max(400).nullable().optional(),
  ogImageId: z.string().max(128).nullable().optional(),
  revalidateSec: z.number().int().min(0).max(86400).optional(),
});

export const UpdatePageSchema = z.object({
  slug: z.string().min(1).max(128).regex(SLUG_PATTERN).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(400).nullable().optional(),
  status: PageStatusEnum.optional(),
  blocksJson: z.array(BlockSchema).max(80).optional(),
  campaignId: z.string().max(64).nullable().optional(),
  sourceType: SiteSourceTypeEnum.nullable().optional(),
  sourceId: z.string().max(64).nullable().optional(),
  pageGoal: SitePageGoalEnum.nullable().optional(),
  noIndex: z.boolean().optional(),
  heroImageId: z.string().max(128).nullable().optional(),
  seoTitle: z.string().max(160).nullable().optional(),
  seoDescription: z.string().max(400).nullable().optional(),
  ogImageId: z.string().max(128).nullable().optional(),
  revalidateSec: z.number().int().min(0).max(86400).optional(),
});

// ── LeadForm ────────────────────────────────────────────────────────────

export const CreateFormSchema = z.object({
  name: z.string().min(1).max(200),
  fieldsJson: z.array(FormFieldSchema).min(1).max(40),
  successAction: SuccessActionSchema,
  notifyEmail: z.string().email().nullable().optional(),
});

export const UpdateFormSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  fieldsJson: z.array(FormFieldSchema).min(1).max(40).optional(),
  successAction: SuccessActionSchema.optional(),
  notifyEmail: z.string().email().nullable().optional(),
});

// ── Submission ──────────────────────────────────────────────────────────

export const UpdateSubmissionSchema = z.object({
  status: SubmissionStatusEnum,
});

export const ListSubmissionsQuerySchema = z.object({
  status: SubmissionStatusEnum.optional(),
  formId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().max(64).optional(),
});

// ── Page generation ────────────────────────────────────────────────────

export const GeneratePageSchema = z.object({
  sourceType: SiteSourceTypeEnum,
  // Required for non-IDEA sources; service-layer guards return a
  // typed 400 if missing.
  sourceId: z.string().min(1).max(64).optional(),
  pageGoal: SitePageGoalEnum,
  // Free-form additional context. Required for IDEA sources (the
  // prompt IS the source), optional for the others.
  customPrompt: z.string().max(4000).optional(),
});
