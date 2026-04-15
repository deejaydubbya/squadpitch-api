// Pure, testable prompt construction for Squadpitch.
//
// No Prisma, no network, no env access. Every caller passes in a
// `ctx` object built by clientOrchestrator.js plus the user's request
// details. This module is the single place content prompts are composed;
// routes and services must NEVER assemble prompts inline.

import { buildContentContext } from "../../industry/contentContextBuilder.js";

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
    required: ["body", "hooks", "hashtags", "cta", "variations", "altText", "imageGuidance"],
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
export function buildUserPrompt(ctx, { kind, channel, bucketKey, guidance, templateType, dataItem, blueprint, realEstateAssets }) {
  const { contentBuckets, channelSettings } = ctx;
  const lines = [];

  const kindInstruction = KIND_INSTRUCTIONS[kind] ?? KIND_INSTRUCTIONS.POST;
  lines.push(`Task: ${kindInstruction}`);
  lines.push(`Channel: ${channel}`);

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

  if (guidance && guidance.trim().length > 0) {
    lines.push(`\nGuidance from operator:\n${guidance.trim()}`);
  }

  lines.push(
    "\nGenerate 3 distinct variations of the content. The primary fields (body, hooks, hashtags, cta) are Version A. Include 2 additional complete variations in the 'variations' array (Version B and Version C). Each variation should take a different angle, tone, or structure while staying on-brand."
  );
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
