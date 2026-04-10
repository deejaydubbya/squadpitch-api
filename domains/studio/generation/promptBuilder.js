// Pure, testable prompt construction for Squadpitch.
//
// No Prisma, no network, no env access. Every caller passes in a
// `ctx` object built by clientOrchestrator.js plus the user's request
// details. This module is the single place content prompts are composed;
// routes and services must NEVER assemble prompts inline.

/**
 * JSON schema consumed by OpenAI's response_format: { type: "json_schema" }.
 * This is the authoritative shape that drafts are persisted in.
 */
export const CONTENT_OUTPUT_SCHEMA = {
  name: "draft",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      body: {
        type: "string",
        description: "The primary content body — the actual post, caption, or script.",
      },
      hooks: {
        type: "array",
        items: { type: "string" },
        description: "Opening lines or attention-grabbing alternatives.",
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        description: "Relevant hashtags without the leading '#'.",
      },
      cta: {
        type: "string",
        description: "Call to action. Empty string if not applicable.",
      },
      variations: {
        type: "array",
        items: { type: "string" },
        description: "Alternative short variations of the body.",
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

  // Example posts — show the model what good output looks like.
  const examples = brand?.examplePosts;
  if (Array.isArray(examples) && examples.length > 0) {
    lines.push("\nExample posts that represent the desired style:");
    for (const ex of examples) {
      const label = ex.label ? `[${ex.label}] ` : "";
      lines.push(`- ${label}${ex.text}`);
    }
  }

  // Anti-patterns to reduce generic AI tone.
  lines.push(`
IMPORTANT — avoid these generic patterns:
- Do NOT open with a question followed by an emoji (e.g. "Ready to transform your workout? 💪")
- Do NOT use "Discover the power of…", "Unlock your potential…", "Transform your…"
- Do NOT start consecutive sentences with the same word
- Do NOT use more than one exclamation mark per post
- Write varied sentence lengths — mix short punchy lines with longer explanatory ones
- The first line should stop the scroll — be specific, surprising, or contrarian`);

  lines.push(
    "\nAlways respond with a single JSON object that matches the provided schema. Do not include any extra prose."
  );

  return lines.join("\n");
}

/**
 * Build the user prompt. The user prompt encodes WHAT we are asking the
 * system to produce right now — the kind of content, the channel, any
 * matched content bucket template, and the operator's guidance.
 */
export function buildUserPrompt(ctx, { kind, channel, bucketKey, guidance }) {
  const { contentBuckets, channelSettings } = ctx;
  const lines = [];

  const kindInstruction = KIND_INSTRUCTIONS[kind] ?? KIND_INSTRUCTIONS.POST;
  lines.push(`Task: ${kindInstruction}`);
  lines.push(`Channel: ${channel}`);

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

  if (guidance && guidance.trim().length > 0) {
    lines.push(`\nGuidance from operator:\n${guidance.trim()}`);
  }

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
