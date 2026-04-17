// Content angles for strategic, differentiated real estate marketing.
//
// Each angle defines a clear PURPOSE for a post — what it should emphasize,
// how it should open, what tone to use, and what CTA fits best.
// Used by Autopilot planning and generation prompts.

// ── Angle definitions ───────────────────────────────────────────────────

export const CONTENT_ANGLES = {
  // LISTING-BASED
  listing_spotlight: {
    key: "listing_spotlight",
    label: "Listing Spotlight",
    category: "listing",
    guidance: `This post should spotlight a specific property listing.
Focus on: standout features, what makes it special, key selling points.
Opening style: Lead with the most compelling feature or a surprising detail.
Tone: Enthusiastic but grounded — let the property speak for itself.
CTA: Encourage viewing, scheduling a tour, or reaching out for details.`,
  },
  just_listed: {
    key: "just_listed",
    label: "Just Listed",
    category: "listing",
    guidance: `This post announces a new listing hitting the market.
Focus on: freshness, urgency (without being pushy), key specs.
Opening style: Lead with the news — this is brand new on the market.
Tone: Timely and direct — convey that this is fresh inventory.
CTA: "Schedule a showing", "DM for details", or "Link in bio".`,
  },
  price_opportunity: {
    key: "price_opportunity",
    label: "Price Opportunity",
    category: "listing",
    guidance: `This post highlights affordability or value in a listing.
Focus on: price-to-value ratio, what buyers get for the price, comparisons to area.
Opening style: Lead with a specific value hook (price point, price per sqft, below median).
Tone: Analytical and helpful — position yourself as a smart buyer's advocate.
CTA: "Let's talk numbers", "See if this fits your budget", "Reach out for a walkthrough".`,
  },
  open_house: {
    key: "open_house",
    label: "Open House",
    category: "listing",
    guidance: `This post promotes an open house event.
Focus on: date/time, property highlights, what visitors will see.
Opening style: Lead with the event — when and where.
Tone: Inviting and warm — make people want to stop by.
CTA: "See you there", "Save the date", "Drop by this weekend".`,
  },

  // BUYER-FOCUSED
  first_time_buyer: {
    key: "first_time_buyer",
    label: "First-Time Buyer",
    category: "buyer",
    guidance: `This post speaks directly to first-time home buyers.
Focus on: demystifying the process, practical tips, encouragement.
Opening style: Lead with a common question or misconception first-time buyers have.
Tone: Supportive and educational — be the expert guide, not the salesperson.
CTA: "Have questions? Let's chat", "DM me your biggest concern".`,
  },
  investment_potential: {
    key: "investment_potential",
    label: "Investment Potential",
    category: "buyer",
    guidance: `This post positions a property or area as an investment opportunity.
Focus on: ROI potential, rental yield, appreciation trends, development nearby.
Opening style: Lead with a data point or trend that signals opportunity.
Tone: Analytical and confident — speak to the investor mindset.
CTA: "Let's run the numbers", "Interested in the full analysis?".`,
  },

  // LIFESTYLE
  neighborhood_lifestyle: {
    key: "neighborhood_lifestyle",
    label: "Neighborhood Lifestyle",
    category: "lifestyle",
    guidance: `This post paints a picture of the lifestyle in a neighborhood or area.
Focus on: what it's like to live there, local favorites, community vibe, walkability.
Opening style: Lead with a vivid scene or specific local detail.
Tone: Warm and descriptive — make readers feel what living there is like.
CTA: "Want to explore this area?", "Know someone who'd love this neighborhood?".`,
  },
  family_living: {
    key: "family_living",
    label: "Family Living",
    category: "lifestyle",
    guidance: `This post highlights family-friendly aspects of a property or area.
Focus on: schools, parks, yard space, safe streets, family amenities.
Opening style: Lead with a relatable family moment or practical detail.
Tone: Warm and practical — speak to parents' priorities.
CTA: "Looking for more space for your family?", "Let's find your family's next chapter".`,
  },

  // AUTHORITY
  market_insight: {
    key: "market_insight",
    label: "Market Insight",
    category: "authority",
    guidance: `This post shares a timely observation about the local real estate market.
Focus on: current trends, data points, what buyers/sellers should know right now.
Opening style: Lead with a surprising stat, trend shift, or bold observation.
Tone: Authoritative and analytical — position yourself as the local market expert.
CTA: "What are you seeing in your market?", "Thoughts? Drop a comment".`,
  },
  local_expertise: {
    key: "local_expertise",
    label: "Local Expertise",
    category: "authority",
    guidance: `This post demonstrates deep local knowledge and professional expertise.
Focus on: insider tips, local market nuances, professional advice.
Opening style: Lead with a specific insight that only a local expert would know.
Tone: Knowledgeable and conversational — share expertise casually.
CTA: "Have a local question? Ask away", "Need an expert perspective?".`,
  },
  trend_commentary: {
    key: "trend_commentary",
    label: "Trend Commentary",
    category: "authority",
    guidance: `This post comments on a broader real estate or housing trend.
Focus on: what's changing, why it matters locally, your professional take.
Opening style: Lead with the trend or headline, then give your angle.
Tone: Thoughtful and opinionated — have a clear point of view.
CTA: "Agree or disagree? Let me know", "What's your take?".`,
  },

  // GROWTH — audience-building, discovery-focused
  curiosity_hook: {
    key: "curiosity_hook",
    label: "Curiosity Hook",
    category: "growth",
    guidance: `This post is designed to stop the scroll and attract NEW followers.
Focus on: a surprising fact, counter-intuitive insight, or "you won't believe" moment.
Opening style: Lead with a bold, curiosity-driven first line that creates an information gap.
Tone: Conversational and intriguing — make readers NEED to keep reading.
CTA: "Follow for more", "Save this for later", "Share with someone who needs this".
Examples of good hooks:
- "You won't believe what $400k gets you in [area]"
- "The #1 mistake first-time buyers make"
- "I just saved a client $30k. Here's how."`,
  },
  value_tips: {
    key: "value_tips",
    label: "Value Tips",
    category: "growth",
    guidance: `This post delivers quick, actionable value that makes people follow for more.
Focus on: practical tips, insider knowledge, "things I wish I knew" insights.
Opening style: Lead with a numbered tip, a bold claim, or a "here's what most people get wrong" framing.
Tone: Generous and expert — give away real value freely.
CTA: "Follow for daily tips", "Save this post", "Which tip surprised you?".
Structure: Listicle or single-tip deep dive. Make each point specific and actionable.`,
  },
  myth_busting: {
    key: "myth_busting",
    label: "Myth Busting",
    category: "growth",
    guidance: `This post busts a common misconception to position you as a trusted authority.
Focus on: a widely-held belief that's wrong or misleading, then the truth.
Opening style: Lead with the myth stated as fact, then flip it — "Actually, here's what's really going on."
Tone: Confident and educational — you're the expert setting the record straight.
CTA: "Follow for more real talk", "What myths have you heard?", "Share this with someone who still believes this".`,
  },
  community_question: {
    key: "community_question",
    label: "Community Question",
    category: "growth",
    guidance: `This post sparks conversation and engagement to boost reach through comments.
Focus on: an opinion-generating question, a "this or that" choice, or a relatable scenario.
Opening style: Lead with a polarizing or thought-provoking question.
Tone: Casual and inviting — make people feel comfortable weighing in.
CTA: "Drop your answer below", "Comment your pick", "Tag someone who'd disagree".
Engagement bait done right — genuine curiosity, not clickbait.`,
  },
};

// Flat array for iteration
export const ANGLE_LIST = Object.values(CONTENT_ANGLES);

// ── Angle selection helpers ─────────────────────────────────────────────

/**
 * Pick the best angle for a given source type, with optional asset-based bias.
 * @param {string} sourceType - "listing" | "review" | "fallback"
 * @param {object} [dataJson] - The data item's JSON payload for signal-based bias
 * @param {Set<string>} [usedAngles] - Angles already used in this batch
 * @returns {object} The selected angle definition
 */
export function pickAngleForSource(sourceType, dataJson, usedAngles = new Set()) {
  const candidates = getAnglesForSource(sourceType);

  // Apply asset-based signals if available
  if (dataJson && sourceType === "listing") {
    const biased = biasAngleByAsset(candidates, dataJson, usedAngles);
    if (biased) return biased;
  }

  // Pick first unused angle, cycling for diversity
  const unused = candidates.filter((a) => !usedAngles.has(a.key));
  if (unused.length > 0) return unused[0];

  // All used — pick least recently used (first candidate)
  return candidates[0];
}

/**
 * Get candidate angles for a source type.
 */
function getAnglesForSource(sourceType) {
  switch (sourceType) {
    case "listing":
      return [
        CONTENT_ANGLES.listing_spotlight,
        CONTENT_ANGLES.just_listed,
        CONTENT_ANGLES.price_opportunity,
        CONTENT_ANGLES.neighborhood_lifestyle,
        CONTENT_ANGLES.family_living,
        CONTENT_ANGLES.investment_potential,
      ];
    case "review":
      return [
        CONTENT_ANGLES.local_expertise,
        CONTENT_ANGLES.market_insight,
      ];
    case "growth":
      return [
        CONTENT_ANGLES.curiosity_hook,
        CONTENT_ANGLES.value_tips,
        CONTENT_ANGLES.myth_busting,
        CONTENT_ANGLES.community_question,
      ];
    case "fallback":
    default:
      return [
        CONTENT_ANGLES.market_insight,
        CONTENT_ANGLES.local_expertise,
        CONTENT_ANGLES.trend_commentary,
        CONTENT_ANGLES.first_time_buyer,
      ];
  }
}

/**
 * Light asset signal bias — use listing data to prefer certain angles.
 * Returns null if no strong signal.
 */
function biasAngleByAsset(candidates, dataJson, usedAngles) {
  if (!dataJson || typeof dataJson !== "object") return null;

  const price = dataJson.price ?? dataJson.listPrice;
  const beds = dataJson.bedrooms ?? dataJson.beds;
  const sqft = dataJson.squareFeet ?? dataJson.sqft;
  const neighborhood = dataJson.neighborhood ?? dataJson.area ?? dataJson.location;

  // Low price relative signal → Price Opportunity
  if (price && typeof price === "number" && price < 350000) {
    const angle = CONTENT_ANGLES.price_opportunity;
    if (!usedAngles.has(angle.key)) return angle;
  }

  // Large home → Family Living
  if ((beds && beds >= 4) || (sqft && sqft >= 2500)) {
    const angle = CONTENT_ANGLES.family_living;
    if (!usedAngles.has(angle.key)) return angle;
  }

  // Has neighborhood info → Neighborhood Lifestyle
  if (neighborhood && typeof neighborhood === "string" && neighborhood.length > 3) {
    const angle = CONTENT_ANGLES.neighborhood_lifestyle;
    if (!usedAngles.has(angle.key)) return angle;
  }

  return null;
}

/**
 * Assign diversified angles to a batch of count items.
 * Cycles through all angles, ensuring no repeats within the batch.
 */
export function assignAngleBatch(count, sourceTypes = []) {
  const usedAngles = new Set();
  const result = [];

  for (let i = 0; i < count; i++) {
    const sourceType = sourceTypes[i] ?? "fallback";
    const angle = pickAngleForSource(sourceType, null, usedAngles);
    usedAngles.add(angle.key);
    result.push(angle);
  }

  return result;
}
