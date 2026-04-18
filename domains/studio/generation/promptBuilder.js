// Pure, testable prompt construction for Squadpitch.
//
// No Prisma, no network, no env access. Every caller passes in a
// `ctx` object built by clientOrchestrator.js plus the user's request
// details. This module is the single place content prompts are composed;
// routes and services must NEVER assemble prompts inline.

import { buildContentContext } from "../../industry/contentContextBuilder.js";
import { buildPatternPromptBlock } from "../viralPatterns.js";

/**
 * JSON schema consumed by OpenAI's response_format: { type: "json_schema" }.
 * This is the authoritative shape that drafts are persisted in.
 */
const VARIATION_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    body: {
      type: "string",
      description: "The content body for this variation.",
    },
    hooks: {
      type: "array",
      items: { type: "string" },
      description: "Opening lines for this variation.",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "Hashtags without leading '#'.",
    },
    cta: {
      type: "string",
      description: "Call to action. Empty string if not applicable.",
    },
  },
  required: ["body", "hooks", "hashtags", "cta"],
};

export const CONTENT_OUTPUT_SCHEMA = {
  name: "draft",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      body: {
        type: "string",
        description: "The primary content body (Version A) — the actual post, caption, or script.",
      },
      hooks: {
        type: "array",
        items: { type: "string" },
        description: "Opening lines or attention-grabbing alternatives for Version A.",
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        description: "Relevant hashtags without the leading '#' for Version A.",
      },
      cta: {
        type: "string",
        description: "Call to action for Version A. Empty string if not applicable.",
      },
      variations: {
        type: "array",
        items: VARIATION_OBJECT_SCHEMA,
        description: "Two additional complete variations (Version B and Version C) of the content, each with a different angle, tone, or structure.",
      },
      scoredHooks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", description: "The hook text — a compelling opening line." },
            hookScore: { type: "integer", description: "Quality score from 0–10 based on curiosity gap, clarity, emotional pull, and platform fit." },
            reason: { type: "string", description: "One sentence explaining why this hook is strong or weak." },
          },
          required: ["text", "hookScore", "reason"],
        },
        description: "5–10 opening hooks scored by quality. Sorted by hookScore descending.",
      },
      altText: {
        type: "string",
        description: "Image alt text for accessibility. Empty string if not applicable.",
      },
      imageGuidance: {
        type: "string",
        description:
          "Detailed visual description for AI image generation — describe the ideal composition, lighting, color palette, mood, and style of an image that would accompany this post. Be specific about what the viewer should see. Empty string if not applicable.",
      },
    },
    required: ["body", "hooks", "hashtags", "cta", "variations", "scoredHooks", "altText", "imageGuidance"],
  },
};

/**
 * Per-kind instruction strings. Keep them focused and free of client-specific
 * data — client data is layered in by buildSystemPrompt / buildUserPrompt.
 */
export const KIND_INSTRUCTIONS = {
  POST: "Write a single social post ready to publish. Write like a human posting to their own feed, not a corporate brand account. Include a strong hook in the first line. Vary sentence length. No filler words.",
  CAPTION: "Write a caption to accompany a visual asset. Keep it concise and benefit-led. Sound human, not like a marketing template.",
  VIDEO_SCRIPT:
    "Write a short-form video script (30–60 seconds). Structure: hook, 2–3 beats, payoff, CTA. Use short sentences and natural spoken language. Write it exactly as someone would say it out loud.",
  CAROUSEL:
    "Write a carousel post as numbered slides. Slide 1 is a strong hook, middle slides build the argument, last slide contains the CTA. Separate slides with '---'. Each slide should be 1–3 sentences max.",
  HOOKS:
    "Generate 5–10 varied opening hooks for the topic. Each hook should be one line. Put the single best hook in 'body' and the rest in 'hooks'.",
  CTA_VARIANTS:
    "Generate 5–10 distinct CTAs for the topic. Put the single best CTA in 'cta' and the rest in 'variations'.",
  REPLY:
    "Write a short conversational reply that sounds like it's coming from the brand. Keep it under three sentences.",
};

/**
 * Build the system prompt from a normalized generation context. The system
 * prompt encodes WHO the brand is, not what the current request is.
 */
export function buildSystemPrompt(ctx) {
  const { client, brand, voice } = ctx;
  const lines = [];

  lines.push(
    `You are the in-house content writer for "${client?.name ?? "the client"}".`
  );
  lines.push(
    "You produce on-brand, high-quality social content that sounds like a real human from this brand, not a marketing bot."
  );

  if (brand) {
    if (brand.description) lines.push(`\nBrand description:\n${brand.description}`);
    if (brand.industry) lines.push(`Industry: ${brand.industry}`);
    if (brand.audience) lines.push(`Target audience:\n${brand.audience}`);
    if (brand.offers) lines.push(`Products / offers:\n${brand.offers}`);
    if (brand.competitors) lines.push(`Known competitors:\n${brand.competitors}`);
  }

  if (voice) {
    if (voice.tone) lines.push(`\nTone: ${voice.tone}`);

    const rules = voice.voiceRulesJson ?? {};
    const doList = Array.isArray(rules.do) ? rules.do : [];
    const dontList = Array.isArray(rules.dont) ? rules.dont : [];
    if (doList.length > 0) {
      lines.push(
        `\nAlways:\n${doList.map((r) => `- ${r}`).join("\n")}`
      );
    }
    if (dontList.length > 0) {
      lines.push(
        `\nNever:\n${dontList.map((r) => `- ${r}`).join("\n")}`
      );
    }

    const banned = Array.isArray(voice.bannedPhrases) ? voice.bannedPhrases : [];
    if (banned.length > 0) {
      lines.push(
        `\nBanned phrases (do not use verbatim): ${banned.join(", ")}`
      );
    }

    const cta = voice.ctaPreferences;
    if (cta && typeof cta === "object") {
      const ctaText = JSON.stringify(cta);
      lines.push(`\nCTA preferences: ${ctaText}`);
    }
  }

  // Industry-specific content guidance — enriches output quality.
  const industry = ctx.industryContext;
  if (industry) {
    lines.push(`\nIndustry specialization: ${industry.label}`);
    lines.push(`Industry context: ${industry.description}`);
    if (industry.contentAngles?.length > 0) {
      lines.push(`\nIndustry-recommended content angles (use these as inspiration, not templates):`);
      industry.contentAngles.forEach((angle) => lines.push(`- ${angle}`));
    }
  }

  // Example posts — show the model what good output looks like.
  const examples = brand?.examplePosts;
  if (Array.isArray(examples) && examples.length > 0) {
    lines.push("\nExample posts that represent the desired style:");
    for (const ex of examples) {
      const label = ex.label ? `[${ex.label}] ` : "";
      lines.push(`- ${label}${ex.text}`);
    }
  }

  // Tech stack context — what tools are connected and what data is available.
  const ts = ctx.techStackContext;
  if (ts && ts.connectedTools.length > 0) {
    lines.push(`\nConnected tools: ${ts.connectedTools.join(", ")}`);
    if (ts.hasWebsite && ts.websiteUrl) {
      lines.push(`Website: ${ts.websiteUrl} — reference real pages, services, and details from the business website when relevant.`);
    }
    if (ts.hasFacebook && ts.facebookPageName) {
      lines.push(`Facebook Page: ${ts.facebookPageName}`);
    }
    if (ts.hasInstagram && ts.instagramAccountName) {
      lines.push(`Instagram: @${ts.instagramAccountName}`);
    }
    if (ts.connectedCapabilities.includes("publishing")) {
      lines.push("This business publishes content directly — write posts that are ready to post, not drafts that need heavy editing.");
    }
  }

  // Real estate specialization — when canonical context is available.
  const reCtx = ctx.realEstateContext;
  if (ctx.industryKey === "real_estate" && reCtx) {
    lines.push(`\n--- REAL ESTATE SPECIALIZATION ---`);
    const bp = reCtx.businessProfile;
    if (bp?.businessName) lines.push(`Business: ${bp.businessName}`);
    if (bp?.marketArea) lines.push(`Market area: ${bp.marketArea}`);
    if (bp?.city && bp?.state) lines.push(`Location: ${bp.city}, ${bp.state}`);

    if (reCtx.assets?.listingCount > 0) {
      lines.push(`Active listings: ${reCtx.assets.listingCount} — use specific listing details when provided. Do not invent property details.`);
    }
    if (reCtx.assets?.reviewCount > 0) {
      lines.push(`Client reviews available: ${reCtx.assets.reviewCount} — weave real client feedback into trust-building content when appropriate.`);
    }

    lines.push(`\nReal estate content rules:`);
    lines.push(`- Use specific property details (address, price, beds/baths) when available — never invent them`);
    lines.push(`- Reference the local market area naturally — sound like a local expert`);
    lines.push(`- Avoid cliches: "dream home", "don't miss out", "act now", "stunning", "gorgeous"`);
    lines.push(`- Keep listings grounded — highlight real features, not superlatives`);
    lines.push(`- Include a soft CTA (schedule a showing, DM for details, link in bio) — never aggressive`);
    lines.push(`--- END REAL ESTATE SPECIALIZATION ---`);
  }

  // Performance feedback context — what works for this workspace.
  const perf = ctx.performanceProfile;
  if (perf && perf.totalRated >= 3) {
    lines.push(`\n--- PERFORMANCE INSIGHTS (adapt your style based on what works) ---`);

    if (perf.topContentTypes.length > 0) {
      const topLabels = perf.topContentTypes.map((t) => t.type).join(", ");
      lines.push(`Best-performing content types: ${topLabels} — lean into these styles when appropriate.`);
    }

    if (perf.weakContentTypes.length > 0) {
      const weakLabels = perf.weakContentTypes.map((t) => t.type).join(", ");
      lines.push(`Lower-performing content types: ${weakLabels} — try a fresh approach if writing in these categories.`);
    }

    if (perf.topHookStyles.length > 0) {
      lines.push(`Strongest hook styles: ${perf.topHookStyles.join(", ")} — prefer these opening patterns.`);
    }

    if (perf.topChannels.length > 0) {
      const bestChannel = perf.topChannels[0];
      lines.push(`Best channel: ${bestChannel.channel} — optimize especially for this platform.`);
    }

    // Variety guard — prevent overfitting
    lines.push(`Note: While adapting to performance patterns, maintain variety. Don't use the same hook style or structure every time.`);
    lines.push(`--- END PERFORMANCE INSIGHTS ---`);
  }

  // Voice consistency — recent published posts as style reference
  const recentPosts = ctx.recentPosts;
  if (Array.isArray(recentPosts) && recentPosts.length > 0) {
    lines.push(`\n--- VOICE REFERENCE (recent published posts — match this style) ---`);
    for (let i = 0; i < Math.min(recentPosts.length, 3); i++) {
      const post = recentPosts[i];
      const excerpt = post.body.length > 200 ? post.body.slice(0, 200) + "…" : post.body;
      lines.push(`[${post.channel}] ${excerpt}`);
    }
    lines.push(`Match the tone, sentence rhythm, and personality of these posts. The new content should feel like it came from the same person.`);
    lines.push(`--- END VOICE REFERENCE ---`);
  }

  // Local authority context — location-based content intelligence
  if (ctx.industryKey === "real_estate" && reCtx) {
    const bp = reCtx?.businessProfile;
    const city = bp?.city;
    const marketArea = bp?.marketArea;
    const state = bp?.state;

    if (city || marketArea) {
      lines.push(`\n--- LOCAL AUTHORITY ---`);
      lines.push(`You are a LOCAL EXPERT in ${marketArea || city}${state ? `, ${state}` : ""}.`);
      lines.push(`When creating content, demonstrate deep local knowledge:`);
      if (city) lines.push(`- Reference specific neighborhoods, streets, and landmarks in ${city}`);
      if (marketArea) lines.push(`- Mention local market trends, price ranges, and buyer/seller dynamics in ${marketArea}`);
      lines.push(`- Include "hidden gems" — local restaurants, parks, schools, community features`);
      lines.push(`- Use local terminology naturally (area nicknames, landmark references)`);
      lines.push(`- Position every post as coming from someone who LIVES and WORKS in this area`);
      lines.push(`- Never write generic content that could apply to any city — be specific`);
      lines.push(`--- END LOCAL AUTHORITY ---`);
    }
  }

  // Anti-patterns to reduce generic AI tone + variety instructions.
  lines.push(`
IMPORTANT — avoid these generic patterns:
- Do NOT open with a question followed by an emoji (e.g. "Ready to transform your workout? 💪")
- Do NOT use "Discover the power of…", "Unlock your potential…", "Transform your…"
- Do NOT use "Exciting news!", "Big announcement!", "We're thrilled to…", "Here's the thing…"
- Do NOT start consecutive sentences with the same word
- Do NOT use more than one exclamation mark per post
- Do NOT repeat the same opening structure across variations

VARIETY — each post should feel fresh:
- Vary opening styles: start with a fact, a bold claim, a short story, a number, a quote, or a direct statement
- Vary tone across variations: one can be conversational, another authoritative, another playful
- Use concrete details over vague language ("sold in 3 days" not "sold quickly")
- Write like a knowledgeable person sharing, not a brand broadcasting
- The first line should stop the scroll — be specific, surprising, or contrarian`);

  lines.push(
    "\nAlways respond with a single JSON object that matches the provided schema. Do not include any extra prose."
  );

  return lines.join("\n");
}

/**
 * Format a business data item for injection into the user prompt.
 * Extracts type-specific fields from dataJson for clarity.
 */
export function formatBusinessDataForPrompt(dataItem) {
  if (!dataItem) return "";
  const lines = [];
  lines.push(`\n--- BUSINESS DATA ---`);
  lines.push(`Type: ${dataItem.type}`);
  lines.push(`Title: ${dataItem.title}`);
  if (dataItem.summary) lines.push(`Summary: ${dataItem.summary}`);

  const d = dataItem.dataJson ?? {};
  switch (dataItem.type) {
    case "TESTIMONIAL":
      if (d.quote) lines.push(`Quote: "${d.quote}"`);
      if (d.author) lines.push(`Author: ${d.author}`);
      if (d.role) lines.push(`Role: ${d.role}`);
      if (d.result) lines.push(`Result: ${d.result}`);
      break;
    case "STATISTIC":
      if (d.metric) lines.push(`Metric: ${d.metric}`);
      if (d.value) lines.push(`Value: ${d.value}`);
      if (d.context) lines.push(`Context: ${d.context}`);
      break;
    case "CASE_STUDY":
      if (d.client) lines.push(`Client: ${d.client}`);
      if (d.challenge) lines.push(`Challenge: ${d.challenge}`);
      if (d.solution) lines.push(`Solution: ${d.solution}`);
      if (d.result) lines.push(`Result: ${d.result}`);
      break;
    case "PRODUCT_LAUNCH":
      if (d.productName) lines.push(`Product: ${d.productName}`);
      if (d.launchDate) lines.push(`Launch date: ${d.launchDate}`);
      if (d.features) lines.push(`Key features: ${d.features}`);
      if (d.pricing) lines.push(`Pricing: ${d.pricing}`);
      break;
    case "PROMOTION":
      if (d.offer) lines.push(`Offer: ${d.offer}`);
      if (d.deadline) lines.push(`Deadline: ${d.deadline}`);
      if (d.code) lines.push(`Code: ${d.code}`);
      if (d.terms) lines.push(`Terms: ${d.terms}`);
      break;
    case "TEAM_SPOTLIGHT":
      if (d.name) lines.push(`Name: ${d.name}`);
      if (d.role) lines.push(`Role: ${d.role}`);
      if (d.funFact) lines.push(`Fun fact: ${d.funFact}`);
      if (d.bio) lines.push(`Bio: ${d.bio}`);
      break;
    case "FAQ":
      if (d.question) lines.push(`Question: ${d.question}`);
      if (d.answer) lines.push(`Answer: ${d.answer}`);
      break;
    case "MILESTONE":
      if (d.achievement) lines.push(`Achievement: ${d.achievement}`);
      if (d.date) lines.push(`Date: ${d.date}`);
      if (d.significance) lines.push(`Significance: ${d.significance}`);
      break;
    case "EVENT":
      if (d.eventName) lines.push(`Event: ${d.eventName}`);
      if (d.date) lines.push(`Date: ${d.date}`);
      if (d.location) lines.push(`Location: ${d.location}`);
      if (d.details) lines.push(`Details: ${d.details}`);
      break;
    case "INDUSTRY_NEWS":
      if (d.headline) lines.push(`Headline: ${d.headline}`);
      if (d.source) lines.push(`Source: ${d.source}`);
      if (d.takeaway) lines.push(`Takeaway: ${d.takeaway}`);
      break;
    default:
      // CUSTOM or any other — dump all keys
      for (const [k, v] of Object.entries(d)) {
        if (v) lines.push(`${k}: ${v}`);
      }
  }

  if (dataItem.tags?.length > 0) {
    lines.push(`Tags: ${dataItem.tags.join(", ")}`);
  }
  lines.push(`--- END BUSINESS DATA ---`);
  return lines.join("\n");
}

/**
 * Format structured content context for injection into the user prompt.
 * This is the industry-transformed version of business data — structured
 * fields the AI can use directly instead of parsing raw key/value pairs.
 */
export function formatContentContextForPrompt(context) {
  if (!context) return "";
  const lines = [];
  lines.push(`\n--- CONTENT CONTEXT ---`);
  lines.push(`Headline: ${context.headline}`);
  if (context.highlights?.length > 0) {
    lines.push(`Key highlights:\n${context.highlights.map((h) => `- ${h}`).join("\n")}`);
  }
  if (context.emotionalHook) lines.push(`Emotional hook: ${context.emotionalHook}`);
  if (context.pricePoint) lines.push(`Price: ${context.pricePoint}`);
  if (context.location) lines.push(`Location: ${context.location}`);
  if (context.urgency) lines.push(`Urgency angle: ${context.urgency}`);
  if (context.authorityTopics?.length > 0) {
    lines.push(`Authority topics:\n${context.authorityTopics.map((t) => `- ${t}`).join("\n")}`);
  }
  if (context.trustSignals?.length > 0) {
    lines.push(`Trust signals:\n${context.trustSignals.map((s) => `- ${s}`).join("\n")}`);
  }
  lines.push(`Use the structured fields above as the primary source for your content. Weave in the headline, highlights, and emotional hook naturally.`);
  lines.push(`--- END CONTENT CONTEXT ---`);
  return lines.join("\n");
}

/**
 * Format a content blueprint angle for injection into the user prompt.
 */
export function formatBlueprintForPrompt(blueprint) {
  if (!blueprint) return "";
  const lines = [];
  lines.push(`\n--- CONTENT ANGLE ---`);
  lines.push(`Blueprint: ${blueprint.name} (${blueprint.category})`);
  lines.push(`Angle: ${blueprint.promptTemplate}`);
  lines.push(`--- END CONTENT ANGLE ---`);
  return lines.join("\n");
}

/**
 * Format a normalized listing for injection into the user prompt.
 * Presents only available fields — never invents missing data.
 */
function formatListingForPrompt(listing) {
  if (!listing) return "";
  const lines = [];
  lines.push(`\n--- LISTING DATA ---`);
  if (listing.title) lines.push(`Property: ${listing.title}`);
  if (listing.address) lines.push(`Address: ${listing.address}`);
  if (listing.price) lines.push(`Price: $${listing.price.toLocaleString()}`);

  const specs = [];
  if (listing.beds) specs.push(`${listing.beds} bed`);
  if (listing.baths) specs.push(`${listing.baths} bath`);
  if (listing.sqft) specs.push(`${listing.sqft.toLocaleString()} sq ft`);
  if (specs.length > 0) lines.push(`Specs: ${specs.join(" / ")}`);

  if (listing.locationSummary) lines.push(`Location: ${listing.locationSummary}`);

  if (listing.highlights?.length > 0) {
    lines.push(`Highlights:\n${listing.highlights.map((h) => `- ${h}`).join("\n")}`);
  }

  lines.push(`\nUse these listing details naturally — do not dump them as a bullet list. Weave the most compelling details into the post.`);
  lines.push(`Only mention details listed above. Do not invent or assume any property features not provided.`);
  lines.push(`--- END LISTING DATA ---`);
  return lines.join("\n");
}

/**
 * Format normalized reviews/trust signals for prompt injection.
 */
function formatReviewsForPrompt(reviews) {
  if (!reviews?.length) return "";
  const lines = [];
  lines.push(`\n--- CLIENT REVIEWS ---`);
  for (const review of reviews.slice(0, 3)) {
    let entry = `"${review.quote}"`;
    if (review.author) entry += ` — ${review.author}`;
    if (review.rating) entry += ` (${review.rating}/5)`;
    lines.push(entry);
  }
  lines.push(`\nUse real client words when building trust-focused content. Quote accurately — do not paraphrase or embellish.`);
  lines.push(`--- END CLIENT REVIEWS ---`);
  return lines.join("\n");
}

/**
 * Build real estate fallback guidance when listing/review data is missing.
 */
function buildRealEstateFallback(reCtx, hasListing, hasReviews) {
  if (hasListing && hasReviews) return "";
  const lines = [];

  if (!hasListing) {
    const bp = reCtx?.businessProfile;
    lines.push(`\nNo specific listing data is available. Instead, focus on:`);
    if (bp?.marketArea) {
      lines.push(`- Local market expertise in ${bp.marketArea}`);
    } else {
      lines.push(`- Local market expertise and neighborhood knowledge`);
    }
    lines.push(`- The agent's services, experience, and value proposition`);
    lines.push(`- Educational real estate content (buying tips, market trends, process guides)`);
    lines.push(`- Community highlights and local insights`);
    lines.push(`Do not reference hypothetical listings or invent property details.`);
  }

  if (!hasReviews) {
    lines.push(`\nNo client reviews are available. Build credibility through:`);
    lines.push(`- Local market knowledge and specific neighborhood expertise`);
    lines.push(`- Professional experience and services offered`);
    lines.push(`- Practical value for buyers and sellers`);
    lines.push(`Do not invent testimonials or fake client quotes.`);
  }

  return lines.join("\n");
}

/**
 * Build the user prompt. The user prompt encodes WHAT we are asking the
 * system to produce right now — the kind of content, the channel, any
 * matched content bucket template, and the operator's guidance.
 */
export function buildUserPrompt(ctx, { kind, channel, bucketKey, guidance, templateType, dataItem, blueprint, realEstateAssets, contentAngle }) {
  const { contentBuckets, channelSettings } = ctx;
  const lines = [];

  const kindInstruction = KIND_INSTRUCTIONS[kind] ?? KIND_INSTRUCTIONS.POST;
  lines.push(`Task: ${kindInstruction}`);
  lines.push(`Channel: ${channel}`);

  // Content angle — strategic direction for this specific draft
  if (contentAngle && contentAngle.guidance) {
    lines.push(`\n--- CONTENT ANGLE: ${contentAngle.label} ---`);
    lines.push(contentAngle.guidance);
    lines.push(`--- END CONTENT ANGLE ---`);
  }

  // Template type framing — gives the AI a clear content category
  if (templateType) {
    const label = templateType.replace(/_/g, " ");
    const industryLabel = ctx.industryContext?.label;
    lines.push(`Content type: ${industryLabel ? `${industryLabel} — ` : ""}${label}`);
  }

  const channelCfg = Array.isArray(channelSettings)
    ? channelSettings.find((c) => c.channel === channel)
    : null;
  if (channelCfg) {
    if (channelCfg.maxChars) {
      lines.push(`Max characters: ${channelCfg.maxChars} (this limit includes the body text AND all hashtags combined — do not exceed it)`);
    }
    lines.push(
      `Emoji allowed: ${channelCfg.allowEmoji === false ? "no" : "yes"}`
    );
    const trailing = Array.isArray(channelCfg.trailingHashtags)
      ? channelCfg.trailingHashtags
      : [];
    if (trailing.length > 0) {
      lines.push(`Always include these trailing hashtags: ${trailing.join(", ")}`);
    }
    if (channelCfg.notes) {
      lines.push(`Channel notes: ${channelCfg.notes}`);
    }
  }

  const bucket = Array.isArray(contentBuckets)
    ? contentBuckets.find((b) => b.key === bucketKey)
    : null;
  if (bucket) {
    lines.push(`\nContent bucket: ${bucket.label}`);
    if (bucket.template) {
      lines.push(`Bucket template / angle:\n${bucket.template}`);
    }
  }

  // Business data injection — with industry-aware transformation when available
  if (dataItem) {
    const contentContext = buildContentContext(dataItem, ctx.industryKey);
    if (contentContext) {
      lines.push(formatContentContextForPrompt(contentContext));
    }
    // Always include raw data as reference
    lines.push(formatBusinessDataForPrompt(dataItem));
    if (ctx.industryContext) {
      lines.push(`\nUse this data to create content specific to the ${ctx.industryContext.label} industry. Reference actual details — do not generalize.`);
    }
  }

  // Blueprint angle injection
  if (blueprint) {
    lines.push(formatBlueprintForPrompt(blueprint));
  }

  // Real estate listing + review context injection
  const reAssets = realEstateAssets;
  const isRealEstate = ctx.industryKey === "real_estate";
  if (isRealEstate && reAssets) {
    if (reAssets.bestListing && !dataItem) {
      // Inject best listing when no specific data item was provided
      lines.push(formatListingForPrompt(reAssets.bestListing));
    }
    if (reAssets.reviews?.length > 0) {
      lines.push(formatReviewsForPrompt(reAssets.reviews));
    }
    // Fallback guidance when assets are missing
    lines.push(buildRealEstateFallback(
      ctx.realEstateContext,
      !!(reAssets.bestListing || dataItem),
      reAssets.reviews?.length > 0,
    ));
  }

  // Channel-specific style hints based on connected tech stack
  const ts = ctx.techStackContext;
  if (isRealEstate) {
    // Real estate channel-aware formatting
    if (channel === "INSTAGRAM") {
      lines.push(`\nTarget: Instagram — write punchier, visual-first content.`);
      lines.push(`- Lead with a scroll-stopping first line (specific detail, not a question)`);
      lines.push(`- Keep body under 150 words — let the image do the work`);
      lines.push(`- End with a clear but soft CTA (DM, link in bio, comment)`);
      lines.push(`- Use line breaks for readability`);
    } else if (channel === "FACEBOOK") {
      lines.push(`\nTarget: Facebook — write slightly longer, community-friendly content.`);
      lines.push(`- Storytelling tone — give context about the neighborhood or market`);
      lines.push(`- Local references resonate: mention streets, landmarks, school districts if known`);
      lines.push(`- Good CTA flow: "Comment below", "Share with someone who...", "Message us"`);
      lines.push(`- 150-250 words is ideal`);
    } else if (channel === "LINKEDIN") {
      lines.push(`\nTarget: LinkedIn — professional, market-expert positioning.`);
      lines.push(`- Lead with a market insight or professional observation`);
      lines.push(`- More analytical tone — data, trends, expertise`);
    } else {
      lines.push(`\nWrite balanced social content — specific enough for engagement, concise enough for any platform.`);
    }
  } else if (ts) {
    if (channel === "INSTAGRAM" && ts.hasInstagram) {
      lines.push("\nThis will be published to their connected Instagram account. Use shorter, visual-first language. Lead with a hook that works without an image preview.");
    } else if (channel === "FACEBOOK" && ts.hasFacebook) {
      lines.push("\nThis will be published to their connected Facebook Page. Write in a slightly longer, conversational tone. Facebook audiences engage more with storytelling and context.");
    }
  }

  // Growth content type — override tone and CTA style for audience building
  if (guidance && guidance.includes("[Type: growth]")) {
    lines.push(`
--- GROWTH CONTENT MODE ---
This content is designed to GROW the audience — attract new followers, maximize reach, and encourage discovery.

HOOK RULES:
- The first line MUST create a curiosity gap or information gap
- Use bold claims, surprising facts, or counter-intuitive statements
- Examples: "You won't believe what $400k gets you…", "3 mistakes buyers make…", "Is now a good time to buy?"
- Never open with a generic question + emoji pattern

TONE:
- Generous, value-first — give away real insights freely
- Conversational, not corporate — write like a trusted friend who happens to be an expert
- Avoid sales language, property pitches, or listing-specific promotion
- Focus on tips, insights, education, and relatable scenarios

CTA STYLE:
- Follow-oriented: "Follow for more", "Follow for daily tips"
- Save-oriented: "Save this for later", "Bookmark this"
- Share-oriented: "Share with someone who needs this", "Tag a friend"
- NEVER use aggressive sales CTAs ("Schedule a showing", "Contact me today")

CONTENT APPROACH:
- Prioritize broad audience topics over niche/specific ones
- Think: what would make a non-follower stop scrolling and hit follow?
- Include practical takeaways people can use immediately
- Use numbers, lists, and specific examples over vague generalizations
--- END GROWTH CONTENT MODE ---`);
  }

  // Viral patterns + engagement boosters — proven hook structures
  const patternBlock = buildPatternPromptBlock(templateType, channel);
  if (patternBlock) lines.push(patternBlock);

  if (guidance && guidance.trim().length > 0) {
    lines.push(`\nGuidance from operator:\n${guidance.trim()}`);
  }

  // Follow CTA injection — when goal is Growth, add follow-oriented CTA even for listing/testimonial content
  if (guidance && guidance.includes("[Goal: Growth]") && !guidance.includes("[Type: growth]")) {
    lines.push(`\nGROWTH GOAL: Include a subtle follow-oriented CTA alongside the primary CTA. Examples: "Follow for more homes like this", "Follow for daily real estate tips". Keep it natural — one line at the end, not forced.`);
  }

  lines.push(
    "\nGenerate 3 distinct variations of the content. The primary fields (body, hooks, hashtags, cta) are Version A. Include 2 additional complete variations in the 'variations' array (Version B and Version C). Each variation should take a different angle, tone, or structure while staying on-brand."
  );

  lines.push(`
HOOKS — generate 5–10 scored opening hooks in the 'scoredHooks' array:
- Each hook must be a distinct opening line (one sentence or phrase)
- Score each 0–10 based on: curiosity gap, clarity, emotional pull, platform fit
- Include a one-sentence reason explaining the score
- Sort by hookScore descending (best first)
- Vary styles: bold claims, questions, numbers, stories, surprises, contrarian takes
- The best hook should also be the first line of the Version A body`);

  lines.push(
    "\nRespond with JSON matching the draft schema."
  );

  return lines.join("\n");
}

/**
 * Return the OpenAI `response_format` value for a structured content request.
 */
export function buildResponseFormat() {
  return {
    type: "json_schema",
    json_schema: CONTENT_OUTPUT_SCHEMA,
  };
}

// ── Listing Campaign ────────────────────────────────────────────────────

/**
 * JSON schema for multi-post campaign sequence response.
 * A single AI call returns 1–10 coordinated posts across days/channels.
 */
export const CAMPAIGN_OUTPUT_SCHEMA = {
  name: "listing_campaign",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      campaignName: {
        type: "string",
        description: "Short campaign name for display, e.g. '123 Main St — Just Listed'.",
      },
      posts: {
        type: "array",
        description: "Coordinated marketing posts for the campaign.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            campaignDay: {
              type: "integer",
              description: "Day number in the campaign sequence (1, 2, 3, etc.).",
            },
            channel: {
              type: "string",
              enum: ["INSTAGRAM", "FACEBOOK", "LINKEDIN", "X"],
              description: "Target platform for this post.",
            },
            angle: {
              type: "string",
              enum: ["promotional", "lifestyle", "urgency", "storytelling", "authority", "social_proof"],
              description: "Content angle/purpose for this post.",
            },
            label: {
              type: "string",
              description: "Short label describing this post's purpose, e.g. 'Just Listed Announcement', 'Feature Highlight', 'Open House Reminder'.",
            },
            body: {
              type: "string",
              description: "The full post/caption text.",
            },
            bodyAlt: {
              type: "string",
              description: "An alternate version of the body text with a different angle or hook",
            },
            hookScore: {
              type: "integer",
              description: "Quality score 0-100 for the opening hook of this post",
            },
            imageHint: {
              type: "string",
              description: "Label of the suggested image for this post (e.g. 'exterior', 'kitchen')",
            },
            slotType: {
              type: "string",
              enum: ["social_post", "email", "listing_description"],
              description: "The type of content slot",
            },
            hashtags: {
              type: "array",
              items: { type: "string" },
              description: "Hashtags without leading '#'. Empty array if not applicable.",
            },
            cta: {
              type: "string",
              description: "Call to action. Empty string if not applicable.",
            },
            subject: {
              type: "string",
              description: "Email subject line. Empty string if not an email post.",
            },
          },
          required: ["campaignDay", "channel", "angle", "label", "body", "bodyAlt", "hookScore", "imageHint", "slotType", "hashtags", "cta", "subject"],
        },
      },
    },
    required: ["campaignName", "posts"],
  },
};

/**
 * Build the user prompt for a listing campaign. Injects property details
 * and asks for 4 distinct content pieces with channel-specific instructions.
 */
/**
 * Campaign-type-specific prompt instructions.
 * Each type changes tone, CTA language, urgency, and output structure.
 */
const CAMPAIGN_TYPE_INSTRUCTIONS = {
  just_listed: `CAMPAIGN TYPE: JUST LISTED
- Tone: Excitement, fresh-to-market energy
- Emphasize unique features and first-look exclusivity
- CTA: "Schedule a showing", "See it before it's gone", "DM for details"
- Urgency: Fresh-to-market, don't wait
- Every channel should convey the thrill of a brand-new listing`,

  open_house: `CAMPAIGN TYPE: OPEN HOUSE
- Tone: Event-focused, inviting, warm
- Include date/time if provided, emphasize attendance
- CTA: "Join us", "Mark your calendar", "RSVP", "Stop by"
- Urgency: Limited-time event, specific date/time
- Make the reader feel personally invited`,

  price_drop: `CAMPAIGN TYPE: PRICE DROP
- Tone: Value-driven, opportunity-focused
- Lead with the new price or savings amount
- CTA: "New price", "Now within reach", "Don't miss this value"
- Urgency: Price won't last, act-now energy
- Frame as an opportunity, not a sign of desperation`,

  just_sold: `CAMPAIGN TYPE: JUST SOLD
- Tone: Celebration, confidence, proof of results
- Highlight speed of sale, final price if appropriate
- CTA: "Thinking of selling?", "Ready to be next?", "Let's talk about your home"
- Urgency: None — this is trust-building, not time-pressure
- Position the agent as effective and reliable`,

  listing_spotlight: `CAMPAIGN TYPE: LISTING SPOTLIGHT
- Tone: Lifestyle/showcase, aspirational, storytelling
- Focus on the neighborhood, lifestyle, and emotional appeal
- CTA: "Imagine living here", "Discover this home", "Learn more"
- Urgency: Low — focus on aspiration and desire
- Paint a picture of life in this home and neighborhood`,
};

export function buildCampaignUserPrompt(ctx, listingData, campaignType, imageContext = null, slots = null) {
  const lines = [];

  // Property details
  lines.push(`--- PROPERTY DETAILS ---`);
  if (listingData.address) lines.push(`Address: ${listingData.address}`);
  if (listingData.price) lines.push(`Price: $${Number(listingData.price).toLocaleString()}`);

  const specs = [];
  if (listingData.beds) specs.push(`${listingData.beds} bed`);
  if (listingData.baths) specs.push(`${listingData.baths} bath`);
  if (listingData.sqft) specs.push(`${Number(listingData.sqft).toLocaleString()} sq ft`);
  if (specs.length > 0) lines.push(`Specs: ${specs.join(" / ")}`);

  if (listingData.propertyType) lines.push(`Property type: ${listingData.propertyType}`);
  if (listingData.description) lines.push(`Description: ${listingData.description}`);
  if (listingData.highlights) lines.push(`Notable features: ${listingData.highlights}`);
  if (listingData.neighborhood) lines.push(`Neighborhood: ${listingData.neighborhood}`);
  if (listingData.cta) lines.push(`Preferred CTA: ${listingData.cta}`);
  if (listingData.agentName) lines.push(`Agent: ${listingData.agentName}`);
  if (listingData.brokerage) lines.push(`Brokerage: ${listingData.brokerage}`);
  if (listingData.yearBuilt) lines.push(`Year built: ${listingData.yearBuilt}`);
  if (listingData.lotSize) lines.push(`Lot size: ${listingData.lotSize}`);
  if (listingData.estimatedValue) lines.push(`Estimated value: $${Number(listingData.estimatedValue).toLocaleString()}`);
  if (listingData.daysOnMarket) lines.push(`Days on market: ${listingData.daysOnMarket}`);
  if (listingData.campaignNotes) lines.push(`Special instructions: ${listingData.campaignNotes}`);
  lines.push(`--- END PROPERTY DETAILS ---`);

  // Available images (optional — from screenshot extraction)
  if (Array.isArray(imageContext) && imageContext.length > 0) {
    lines.push(`\n--- AVAILABLE PROPERTY IMAGES ---`);
    imageContext.slice(0, 8).forEach((img, idx) => {
      const label = (img.label || "photo").replace(/_/g, " ");
      const desc = img.description ? ` — ${img.description}` : "";
      lines.push(`${idx + 1}. ${label}${desc}`);
    });
    lines.push(`--- END AVAILABLE IMAGES ---`);
    lines.push(`Reference the available images in each post where appropriate.`);
  }

  // Custom slots section (when provided by the user)
  if (Array.isArray(slots) && slots.length > 0) {
    lines.push(`\nCAMPAIGN STRUCTURE:
Generate exactly ${slots.length} posts matching these slot specifications:

${slots.map((s, i) => `${i + 1}. Day ${s.campaignDay}: "${s.label}" on ${s.channel}${s.slotType ? ` (${s.slotType})` : ''}${s.angle ? ` — angle: ${s.angle}` : ''}`).join('\n')}

Each post must match its slot's channel, campaignDay, and label. Use the label as the creative direction for that post's angle and content.`);
  }

  // Campaign type instructions
  const typeKey = campaignType ?? "just_listed";
  const typeInstructions = CAMPAIGN_TYPE_INSTRUCTIONS[typeKey];
  if (typeInstructions) {
    lines.push(`\n${typeInstructions}\n`);
  }

  // Multi-post campaign instructions
  if (Array.isArray(slots) && slots.length > 0) {
    // Slots provided — use custom structure, skip default post sequence
    lines.push(`
Generate a multi-post marketing campaign sequence. Use the property details above as the foundation — do not invent features not listed.

PLATFORM GUIDELINES:
- Instagram: Short, punchy, 15-20 hashtags, soft CTA (DM, link in bio)
- Facebook: Longer storytelling, 3-5 hashtags, community engagement CTA
- LinkedIn: Professional tone, market insights, 3-5 hashtags
- X: Concise, punchy, 2-3 hashtags max

RULES:`);
  } else {
    // No slots — use default 5-post structure
    lines.push(`
Generate a multi-post marketing campaign sequence. Use the property details above as the foundation — do not invent features not listed.

CAMPAIGN STRUCTURE:
Generate exactly 5 coordinated posts that roll out over multiple days. Each post must have a DIFFERENT angle and purpose — no repetition.

POST SEQUENCE (follow this structure):

Day 1 — LAUNCH POST (Instagram or Facebook)
  Angle: promotional
  Purpose: First announcement, showcase the property, create excitement
  Style: Strong hook, key features, scroll-stopping first line

Day 2 — FEATURE HIGHLIGHT (Facebook or Instagram)
  Angle: storytelling
  Purpose: Deep dive into standout features, neighborhood, or lifestyle
  Style: Longer storytelling format, paint a picture of living here

Day 3 — LIFESTYLE / SOCIAL PROOF (Instagram)
  Angle: lifestyle or social_proof
  Purpose: Emotional appeal — neighborhood, community, aspirational living
  Style: Conversational, relatable, community-focused

Day 5 — VALUE / AUTHORITY (LinkedIn or Facebook)
  Angle: authority or social_proof
  Purpose: Market context, agent expertise, why this listing matters
  Style: Professional, data-informed, trust-building

Day 7 — URGENCY / CTA (Instagram or Facebook)
  Angle: urgency
  Purpose: Drive action — open house, schedule showing, final push
  Style: Direct, time-sensitive, clear call to action

PLATFORM GUIDELINES:
- Instagram: Short, punchy, 15-20 hashtags, soft CTA (DM, link in bio)
- Facebook: Longer storytelling, 3-5 hashtags, community engagement CTA
- LinkedIn: Professional tone, market insights, 3-5 hashtags
- X: Concise, punchy, 2-3 hashtags max

RULES:`);
  }

  lines.push(`\
- Use REAL details from the property — never invent or assume
- No cliches: "dream home", "don't miss out", "act now", "stunning", "gorgeous"
- Each post must feel distinct — different angle, different hook, different value
- Soft CTAs only — never aggressive or high-pressure
- Match the local market tone — sound like a knowledgeable local agent
- Coordinate messaging across posts — they should build on each other
- Set "subject" to empty string for non-email posts
- For each post, also generate a \`bodyAlt\` — an alternate version of the body text with a distinctly different hook or angle. The alternate should not be a minor rewording but a genuinely different take.
- For each post, score the opening hook 0-100 in \`hookScore\` (100 = extremely compelling, 0 = generic).
- For each post, suggest which property image best fits this post in \`imageHint\` — use the image labels provided above (e.g. 'exterior', 'kitchen'). If no images were provided, leave imageHint empty.
- Set \`slotType\` to 'social_post' for all social media posts, 'email' for email content, 'listing_description' for MLS/website listings.`);

  lines.push("\nRespond with JSON matching the listing_campaign schema.");

  return lines.join("\n");
}

/**
 * Return the OpenAI `response_format` for a listing campaign request.
 */
export function buildCampaignResponseFormat() {
  return {
    type: "json_schema",
    json_schema: CAMPAIGN_OUTPUT_SCHEMA,
  };
}

// ── Single Post Regeneration ──────────────────────────────────────────

/**
 * JSON schema for a single regenerated campaign post.
 * Mirrors the post item shape inside CAMPAIGN_OUTPUT_SCHEMA.
 */
export const SINGLE_POST_SCHEMA = {
  name: "single_campaign_post",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      post: {
        type: "object",
        additionalProperties: false,
        properties: {
          campaignDay: {
            type: "integer",
            description: "Day number in the campaign sequence (1, 2, 3, etc.).",
          },
          channel: {
            type: "string",
            enum: ["INSTAGRAM", "FACEBOOK", "LINKEDIN", "X"],
            description: "Target platform for this post.",
          },
          angle: {
            type: "string",
            enum: ["promotional", "lifestyle", "urgency", "storytelling", "authority", "social_proof"],
            description: "Content angle/purpose for this post.",
          },
          label: {
            type: "string",
            description: "Short label describing this post's purpose.",
          },
          body: {
            type: "string",
            description: "The full post/caption text.",
          },
          bodyAlt: {
            type: "string",
            description: "An alternate version of the body text with a different angle or hook",
          },
          hookScore: {
            type: "integer",
            description: "Quality score 0-100 for the opening hook of this post",
          },
          imageHint: {
            type: "string",
            description: "Label of the suggested image for this post (e.g. 'exterior', 'kitchen')",
          },
          slotType: {
            type: "string",
            enum: ["social_post", "email", "listing_description"],
            description: "The type of content slot",
          },
          hashtags: {
            type: "array",
            items: { type: "string" },
            description: "Hashtags without leading '#'. Empty array if not applicable.",
          },
          cta: {
            type: "string",
            description: "Call to action. Empty string if not applicable.",
          },
          subject: {
            type: "string",
            description: "Email subject line. Empty string if not an email post.",
          },
        },
        required: ["campaignDay", "channel", "angle", "label", "body", "bodyAlt", "hookScore", "imageHint", "slotType", "hashtags", "cta", "subject"],
      },
    },
    required: ["post"],
  },
};

/**
 * Build the user prompt for regenerating a single campaign post.
 * Includes property details, the specific slot info, campaign context, and image context.
 */
export function buildRegeneratePostUserPrompt(ctx, propertyData, campaignType, slot, campaignSummary, imageContext = null) {
  const lines = [];

  // Property details (same as full campaign prompt)
  lines.push(`--- PROPERTY DETAILS ---`);
  if (propertyData.address) lines.push(`Address: ${propertyData.address}`);
  if (propertyData.price) lines.push(`Price: $${Number(propertyData.price).toLocaleString()}`);

  const specs = [];
  if (propertyData.beds) specs.push(`${propertyData.beds} bed`);
  if (propertyData.baths) specs.push(`${propertyData.baths} bath`);
  if (propertyData.sqft) specs.push(`${Number(propertyData.sqft).toLocaleString()} sq ft`);
  if (specs.length > 0) lines.push(`Specs: ${specs.join(" / ")}`);

  if (propertyData.propertyType) lines.push(`Property type: ${propertyData.propertyType}`);
  if (propertyData.description) lines.push(`Description: ${propertyData.description}`);
  if (propertyData.highlights) lines.push(`Notable features: ${propertyData.highlights}`);
  if (propertyData.neighborhood) lines.push(`Neighborhood: ${propertyData.neighborhood}`);
  if (propertyData.cta) lines.push(`Preferred CTA: ${propertyData.cta}`);
  if (propertyData.agentName) lines.push(`Agent: ${propertyData.agentName}`);
  if (propertyData.brokerage) lines.push(`Brokerage: ${propertyData.brokerage}`);
  if (propertyData.yearBuilt) lines.push(`Year built: ${propertyData.yearBuilt}`);
  if (propertyData.lotSize) lines.push(`Lot size: ${propertyData.lotSize}`);
  if (propertyData.estimatedValue) lines.push(`Estimated value: $${Number(propertyData.estimatedValue).toLocaleString()}`);
  if (propertyData.daysOnMarket) lines.push(`Days on market: ${propertyData.daysOnMarket}`);
  if (propertyData.campaignNotes) lines.push(`Special instructions: ${propertyData.campaignNotes}`);
  lines.push(`--- END PROPERTY DETAILS ---`);

  // Available images (optional)
  if (Array.isArray(imageContext) && imageContext.length > 0) {
    lines.push(`\n--- AVAILABLE PROPERTY IMAGES ---`);
    imageContext.slice(0, 8).forEach((img, idx) => {
      const label = (img.label || "photo").replace(/_/g, " ");
      const desc = img.description ? ` — ${img.description}` : "";
      lines.push(`${idx + 1}. ${label}${desc}`);
    });
    lines.push(`--- END AVAILABLE IMAGES ---`);
    lines.push(`Reference the available images where appropriate.`);
  }

  // Campaign type instructions
  const typeKey = campaignType ?? "just_listed";
  const typeInstructions = CAMPAIGN_TYPE_INSTRUCTIONS[typeKey];
  if (typeInstructions) {
    lines.push(`\n${typeInstructions}\n`);
  }

  // Slot-specific instructions
  lines.push(`--- SLOT TO REGENERATE ---`);
  lines.push(`Channel: ${slot.channel}`);
  lines.push(`Day: ${slot.day}`);
  lines.push(`Label: ${slot.label}`);
  if (slot.angle) lines.push(`Angle: ${slot.angle}`);
  lines.push(`--- END SLOT ---`);

  // Campaign context (other posts for coordination)
  if (Array.isArray(campaignSummary) && campaignSummary.length > 0) {
    lines.push(`\n--- OTHER POSTS IN THIS CAMPAIGN (for coordination — do NOT duplicate these) ---`);
    campaignSummary.forEach((s) => lines.push(`- Day ${s.day || "?"}: ${s.label || "Untitled"} (${s.channel || "?"}) — ${s.angle || "?"}`));
    lines.push(`--- END CAMPAIGN CONTEXT ---`);
  }

  lines.push(`
Generate ONE replacement post for the slot described above. It must be fresh — do not repeat hooks or angles from the other posts in the campaign.

RULES:
- Use REAL details from the property — never invent or assume
- No cliches: "dream home", "don't miss out", "act now", "stunning", "gorgeous"
- Soft CTAs only — never aggressive or high-pressure
- Match the local market tone — sound like a knowledgeable local agent
- Generate a \`bodyAlt\` — an alternate version of the body with a distinctly different hook or angle (not a minor rewording)
- Score the opening hook 0-100 in \`hookScore\` (100 = extremely compelling, 0 = generic)
- Suggest which property image best fits this post in \`imageHint\` — use the image labels provided above. If no images were provided, leave imageHint empty.
- Set \`slotType\` to 'social_post' for social media posts, 'email' for email content, 'listing_description' for MLS/website listings.
- Set "subject" to empty string for non-email posts

Respond with JSON matching the single_campaign_post schema.`);

  return lines.join("\n");
}

/**
 * Return the OpenAI `response_format` for a single-post regeneration request.
 */
export function buildRegeneratePostResponseFormat() {
  return {
    type: "json_schema",
    json_schema: SINGLE_POST_SCHEMA,
  };
}

// ── Content Remix ─────────────────────────────────────────────────────

const REMIX_FORMAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    body: { type: "string", description: "Full post/caption/script text for this format." },
    hooks: {
      type: "array",
      items: { type: "string" },
      description: "2-3 opening hooks optimized for this format.",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "Hashtags without leading '#'. Empty array if not applicable.",
    },
    cta: { type: "string", description: "Call to action. Empty string if not applicable." },
  },
  required: ["body", "hooks", "hashtags", "cta"],
};

export const REMIX_OUTPUT_SCHEMA = {
  name: "content_remix",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      post: {
        ...REMIX_FORMAT_SCHEMA,
        description: "Standard social media post — concise, punchy, platform-ready.",
      },
      carousel: {
        ...REMIX_FORMAT_SCHEMA,
        description: "Carousel post — numbered slides separated by '---'. Slide 1 = hook, middle = value, last = CTA.",
      },
      videoScript: {
        ...REMIX_FORMAT_SCHEMA,
        description: "Short-form video script (30-60s) — written as spoken word. Hook → beats → payoff → CTA.",
      },
      storyCaption: {
        ...REMIX_FORMAT_SCHEMA,
        description: "Story/reel caption — ultra-short, punchy, 1-3 sentences with urgency.",
      },
    },
    required: ["post", "carousel", "videoScript", "storyCaption"],
  },
};

/**
 * Build the user prompt for content remixing.
 * Takes the original post body and remixes it into 4 formats.
 */
export function buildRemixUserPrompt(originalBody, channel) {
  const lines = [];

  lines.push(`--- ORIGINAL CONTENT ---`);
  lines.push(originalBody);
  lines.push(`--- END ORIGINAL CONTENT ---`);

  lines.push(`
Remix this content into 4 distinct formats. Keep the core message, facts, and value — but adapt the structure, length, and style for each format.

FORMAT REQUIREMENTS:

1. POST — Standard social media post
   - Platform-ready for ${channel || "any platform"}
   - Strong hook first line
   - 100-250 words
   - Natural paragraph breaks
   - Relevant hashtags

2. CAROUSEL — Multi-slide post
   - Separate slides with '---'
   - Slide 1: Attention-grabbing hook
   - Slides 2-5: Key points, one idea per slide
   - Last slide: Clear CTA
   - Each slide: 1-3 short sentences max
   - 5-7 slides total

3. VIDEO SCRIPT — Short-form video (30-60 seconds)
   - Written exactly as someone would say it aloud
   - Hook (first 3 seconds): bold statement or question
   - Body (20-40 seconds): 2-3 key beats, conversational
   - Payoff + CTA (last 10 seconds): clear takeaway
   - Use short sentences, natural pauses
   - No emojis or hashtags in the script body

4. STORY CAPTION — Ultra-short story/reel caption
   - 1-3 sentences maximum
   - Punchy, immediate, creates urgency
   - Works without context (viewer may not see original post)
   - Strong CTA or engagement prompt

RULES:
- Each format must feel native to its medium — not a copy-paste resize
- Maintain the original tone and key facts
- Vary the opening hook for each format
- Include relevant hashtags for post and carousel only`);

  lines.push("\nRespond with JSON matching the content_remix schema.");

  return lines.join("\n");
}

/**
 * Return the OpenAI `response_format` for a remix request.
 */
export function buildRemixResponseFormat() {
  return {
    type: "json_schema",
    json_schema: REMIX_OUTPUT_SCHEMA,
  };
}
