// Viral Pattern Library + Engagement Boosters.
//
// Reusable content patterns organized by category. Used by promptBuilder
// to inject proven hook structures and engagement prompts into generation.
//
// Three exports:
//   VIRAL_PATTERNS      — categorized hook/structure patterns
//   ENGAGEMENT_BOOSTERS — comment/save/share prompts
//   getPatterns          — filter patterns by category, channel, or content type

// ── Viral Patterns ──────────────────────────────────────────────────────

export const VIRAL_PATTERNS = [
  // ── Curiosity Gap ──
  {
    id: "curiosity_price",
    pattern: "You won't believe what $[X] gets you in [city]…",
    category: "curiosity",
    useCases: ["listing", "growth", "market_update"],
    channels: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    example: "You won't believe what $350k gets you in Austin…",
  },
  {
    id: "curiosity_secret",
    pattern: "The [thing] most [people] don't know about [topic]",
    category: "curiosity",
    useCases: ["growth", "educational", "authority"],
    channels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
    example: "The one thing most first-time buyers don't know about inspections",
  },
  {
    id: "curiosity_this_or_that",
    pattern: "[Option A] or [Option B]? The answer might surprise you.",
    category: "curiosity",
    useCases: ["growth", "engagement"],
    channels: ["INSTAGRAM", "TIKTOK"],
    example: "Renting or buying? The answer might surprise you.",
  },
  {
    id: "curiosity_what_happened",
    pattern: "We listed this [property] at $[X]. Here's what happened.",
    category: "curiosity",
    useCases: ["listing", "growth"],
    channels: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    example: "We listed this home at $425k. Here's what happened.",
  },

  // ── Listicle / Number ──
  {
    id: "list_mistakes",
    pattern: "Top [N] mistakes [audience] make when [action]",
    category: "listicle",
    useCases: ["growth", "educational"],
    channels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN", "TIKTOK"],
    example: "Top 3 mistakes first-time buyers make when house hunting",
  },
  {
    id: "list_things_to_know",
    pattern: "[N] things I wish I knew before [action]",
    category: "listicle",
    useCases: ["growth", "educational"],
    channels: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    example: "5 things I wish I knew before buying my first home",
  },
  {
    id: "list_signs",
    pattern: "[N] signs [situation]",
    category: "listicle",
    useCases: ["growth", "educational"],
    channels: ["INSTAGRAM", "TIKTOK"],
    example: "4 signs you're ready to buy your first home",
  },
  {
    id: "list_reasons",
    pattern: "[N] reasons why [claim]",
    category: "listicle",
    useCases: ["growth", "authority"],
    channels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
    example: "3 reasons why this neighborhood is blowing up right now",
  },

  // ── Before / After ──
  {
    id: "before_after_transformation",
    pattern: "Before vs after: [transformation]",
    category: "before_after",
    useCases: ["listing", "growth"],
    channels: ["INSTAGRAM", "TIKTOK"],
    example: "Before vs after: This $15k renovation added $60k in value",
  },
  {
    id: "before_after_expectation",
    pattern: "What I expected vs. what actually happened",
    category: "before_after",
    useCases: ["growth", "personal"],
    channels: ["INSTAGRAM", "TIKTOK"],
    example: "What I expected selling my first home vs. what actually happened",
  },

  // ── Bold Claim / Contrarian ──
  {
    id: "bold_stop",
    pattern: "Stop [common action]. Here's why.",
    category: "bold",
    useCases: ["growth", "educational"],
    channels: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
    example: "Stop waiting for rates to drop. Here's why.",
  },
  {
    id: "bold_unpopular",
    pattern: "Unpopular opinion: [contrarian take]",
    category: "bold",
    useCases: ["growth", "authority"],
    channels: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
    example: "Unpopular opinion: You don't need 20% down to buy a home",
  },
  {
    id: "bold_truth",
    pattern: "The truth about [topic] nobody talks about",
    category: "bold",
    useCases: ["growth", "educational"],
    channels: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    example: "The truth about closing costs nobody talks about",
  },

  // ── Story / Personal ──
  {
    id: "story_just_helped",
    pattern: "Just helped [person/couple] [achievement]. Here's their story.",
    category: "story",
    useCases: ["testimonial", "personal"],
    channels: ["INSTAGRAM", "FACEBOOK"],
    example: "Just helped a young couple close on their dream home. Here's their story.",
  },
  {
    id: "story_behind_scenes",
    pattern: "Behind the scenes of [event/process]",
    category: "story",
    useCases: ["personal", "listing"],
    channels: ["INSTAGRAM", "TIKTOK"],
    example: "Behind the scenes of what goes into listing a home",
  },

  // ── Local / Authority ──
  {
    id: "local_neighborhood",
    pattern: "Best neighborhoods in [city] for [audience/lifestyle]",
    category: "local",
    useCases: ["growth", "authority", "lifestyle"],
    channels: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    example: "Best neighborhoods in Denver for young families",
  },
  {
    id: "local_hidden_gem",
    pattern: "Hidden gem: [place/detail] in [area]",
    category: "local",
    useCases: ["growth", "lifestyle"],
    channels: ["INSTAGRAM", "FACEBOOK"],
    example: "Hidden gem: this coffee shop in Capitol Hill you need to try",
  },
  {
    id: "local_market_trend",
    pattern: "[City] market update: [key stat or trend]",
    category: "local",
    useCases: ["authority", "market_update"],
    channels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
    example: "Austin market update: inventory just hit a 2-year high",
  },

  // ── Question / Poll ──
  {
    id: "question_would_you",
    pattern: "Would you [action]? [Brief scenario]",
    category: "question",
    useCases: ["engagement", "growth"],
    channels: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    example: "Would you buy a home sight-unseen? More people are doing it than you think.",
  },
  {
    id: "question_hot_take",
    pattern: "Hot take: [opinion]. Agree or disagree?",
    category: "question",
    useCases: ["growth", "engagement"],
    channels: ["INSTAGRAM", "TIKTOK"],
    example: "Hot take: granite countertops are overrated. Agree or disagree?",
  },
];

// ── Engagement Boosters ──────────────────────────────────────────────────

export const ENGAGEMENT_BOOSTERS = [
  // Comment-driven
  { id: "comment_keyword", text: 'Comment "[KEYWORD]" for details', type: "comment", intensity: "medium" },
  { id: "comment_city", text: "Drop your city below — I'll share what $[X] gets you there", type: "comment", intensity: "high" },
  { id: "comment_emoji", text: "🏡 if you'd buy it, 👀 if you'd pass", type: "comment", intensity: "low" },
  { id: "comment_question", text: "Would you live here? Tell me why or why not", type: "comment", intensity: "medium" },
  { id: "comment_guess", text: "Guess the price 👇", type: "comment", intensity: "high" },

  // Save-driven
  { id: "save_reference", text: "Save this for when you're ready to buy", type: "save", intensity: "low" },
  { id: "save_tips", text: "Bookmark these tips — you'll need them", type: "save", intensity: "low" },
  { id: "save_checklist", text: "Save this checklist for later", type: "save", intensity: "low" },

  // Share-driven
  { id: "share_tag", text: "Tag someone who needs to see this", type: "share", intensity: "medium" },
  { id: "share_send", text: "Send this to a friend who's house hunting", type: "share", intensity: "medium" },
  { id: "share_couple", text: "Share with your partner — start the conversation", type: "share", intensity: "low" },

  // Follow-driven
  { id: "follow_daily", text: "Follow for daily real estate tips", type: "follow", intensity: "low" },
  { id: "follow_more", text: "Follow for more homes like this", type: "follow", intensity: "low" },
  { id: "follow_market", text: "Follow to stay ahead of the market", type: "follow", intensity: "low" },
];

// ── getPatterns ──────────────────────────────────────────────────────────

/**
 * Filter patterns by category, content type, and/or channel.
 *
 * @param {object} [opts]
 * @param {string} [opts.category]    — "curiosity", "listicle", "bold", etc.
 * @param {string} [opts.contentType] — "growth", "listing", "educational", etc.
 * @param {string} [opts.channel]     — "INSTAGRAM", "FACEBOOK", etc.
 * @param {number} [opts.limit]       — max results (default 5)
 * @returns {Array}
 */
export function getPatterns({ category, contentType, channel, limit = 5 } = {}) {
  let filtered = VIRAL_PATTERNS;

  if (category) {
    filtered = filtered.filter((p) => p.category === category);
  }
  if (contentType) {
    filtered = filtered.filter((p) => p.useCases.includes(contentType));
  }
  if (channel) {
    filtered = filtered.filter((p) => p.channels.includes(channel));
  }

  // Shuffle for variety, then limit
  const shuffled = filtered.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit);
}

/**
 * Get engagement boosters appropriate for the content type and intensity level.
 *
 * @param {object} [opts]
 * @param {string} [opts.type]      — "comment", "save", "share", "follow"
 * @param {string} [opts.intensity] — "low", "medium", "high"
 * @param {number} [opts.limit]     — max results (default 2)
 * @returns {Array}
 */
export function getEngagementBoosters({ type, intensity, limit = 2 } = {}) {
  let filtered = ENGAGEMENT_BOOSTERS;

  if (type) {
    filtered = filtered.filter((b) => b.type === type);
  }
  if (intensity) {
    filtered = filtered.filter((b) => b.intensity === intensity);
  }

  const shuffled = filtered.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit);
}

/**
 * Build a prompt-ready pattern reference block.
 * Used by promptBuilder to inject into generation prompts.
 */
export function buildPatternPromptBlock(contentType, channel) {
  const patterns = getPatterns({ contentType, channel, limit: 4 });
  const boosters = getEngagementBoosters({ limit: 2 });

  if (patterns.length === 0 && boosters.length === 0) return "";

  const lines = [];
  lines.push(`\n--- PROVEN CONTENT PATTERNS ---`);

  if (patterns.length > 0) {
    lines.push(`Use these proven hook patterns as INSPIRATION (adapt them, don't copy verbatim):`);
    for (const p of patterns) {
      lines.push(`- "${p.pattern}" (e.g. "${p.example}")`);
    }
  }

  if (boosters.length > 0) {
    lines.push(`\nEngagement boosters (use ONE sparingly at the end — don't force it):`);
    for (const b of boosters) {
      lines.push(`- ${b.text}`);
    }
  }

  lines.push(`\nDo NOT use these patterns word-for-word. Adapt them to the specific content and brand voice.`);
  lines.push(`--- END PROVEN CONTENT PATTERNS ---`);

  return lines.join("\n");
}
