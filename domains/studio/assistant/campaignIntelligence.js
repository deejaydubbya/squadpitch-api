// Campaign Intelligence — JS mirror of the frontend module.
// Pure functions, no DB/network calls. All inputs are plain objects.

const DEFAULT_CHANNELS_BY_CAMPAIGN_TYPE = {
  just_listed: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
  open_house: ["INSTAGRAM", "FACEBOOK"],
  price_drop: ["INSTAGRAM", "FACEBOOK"],
  general_promotion: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
};

const CAMPAIGN_LABELS = {
  just_listed: "Just Listed",
  open_house: "Open House",
  price_drop: "Price Drop",
  general_promotion: "General Promotion",
};

// ── 1. recommendCampaignType ────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} propertyData
 * @returns {{ recommended: string, confidence: string, reason: string, alternatives: string[] }}
 */
export function recommendCampaignType(propertyData) {
  const allTypes = ["just_listed", "open_house", "price_drop", "general_promotion"];

  const openHouseDate = propertyData.openHouseDate;
  if (openHouseDate) {
    const ohDate = new Date(openHouseDate);
    if (!isNaN(ohDate.getTime()) && ohDate > new Date()) {
      return {
        recommended: "open_house",
        confidence: "high",
        reason: "An upcoming open house is scheduled",
        alternatives: allTypes.filter((t) => t !== "open_house"),
      };
    }
  }

  const { listingStatus, daysOnMarket, price, previousPrice } = propertyData;

  if (listingStatus === "active" && typeof daysOnMarket === "number" && daysOnMarket <= 7) {
    return {
      recommended: "just_listed",
      confidence: "high",
      reason: `Listed ${daysOnMarket} day${daysOnMarket !== 1 ? "s" : ""} ago — perfect timing for a launch campaign`,
      alternatives: allTypes.filter((t) => t !== "just_listed"),
    };
  }

  if (listingStatus === "active" && typeof daysOnMarket === "number" && daysOnMarket <= 14) {
    return {
      recommended: "just_listed",
      confidence: "medium",
      reason: `Listed ${daysOnMarket} days ago — still fresh enough for a launch push`,
      alternatives: allTypes.filter((t) => t !== "just_listed"),
    };
  }

  if (typeof previousPrice === "number" && typeof price === "number" && price < previousPrice) {
    return {
      recommended: "price_drop",
      confidence: "high",
      reason: `Price reduced from ${formatPrice(previousPrice)} to ${formatPrice(price)}`,
      alternatives: allTypes.filter((t) => t !== "price_drop"),
    };
  }

  if (listingStatus === "active" && typeof daysOnMarket === "number" && daysOnMarket > 14) {
    return {
      recommended: "general_promotion",
      confidence: "medium",
      reason: `On market for ${daysOnMarket} days — a fresh promotional push can reignite interest`,
      alternatives: allTypes.filter((t) => t !== "general_promotion"),
    };
  }

  return {
    recommended: "general_promotion",
    confidence: "low",
    reason: "General promotion works for any listing",
    alternatives: allTypes.filter((t) => t !== "general_promotion"),
  };
}

// ── 2. recommendChannels ────────────────────────────────────────────────

/**
 * @param {{ campaignType: string, connectedChannels: string[], hasMedia: boolean, propertyData: Record<string, unknown> }} input
 * @returns {{ recommended: string[], reasoning: Record<string, string> }}
 */
export function recommendChannels({ campaignType, connectedChannels, hasMedia, propertyData }) {
  const defaults = DEFAULT_CHANNELS_BY_CAMPAIGN_TYPE[campaignType] || [];
  const reasoning = {};

  let recommended = defaults.filter((ch) => connectedChannels.includes(ch));

  for (const ch of recommended) {
    reasoning[ch] = `Default channel for ${CAMPAIGN_LABELS[campaignType] || campaignType} campaigns`;
  }

  if (!hasMedia && recommended.includes("INSTAGRAM")) {
    recommended = recommended.filter((ch) => ch !== "INSTAGRAM");
    reasoning["INSTAGRAM"] = "Excluded — Instagram requires media and none is available";
  }

  const price = propertyData.price;
  if (typeof price === "number" && price >= 750000 && connectedChannels.includes("LINKEDIN") && !recommended.includes("LINKEDIN")) {
    recommended.push("LINKEDIN");
    reasoning["LINKEDIN"] = "Added for luxury listing — LinkedIn reaches high-value audiences";
  }

  if (campaignType === "open_house" && recommended.includes("FACEBOOK")) {
    reasoning["FACEBOOK"] = "Prioritized for open house — Facebook has strong local reach and events";
  }

  if (recommended.length === 0 && connectedChannels.length > 0) {
    recommended = [connectedChannels[0]];
    reasoning[connectedChannels[0]] = "Fallback — only available connected channel";
  }

  return { recommended, reasoning };
}

// ── 3. prioritizeMedia ──────────────────────────────────────────────────

/**
 * @param {Array<{ id: string, filename?: string, tags?: string[], caption?: string, qualityScore?: number, qualityLabel?: string }>} assets
 * @param {{ campaignType: string, slotCount: number }} input
 * @returns {{ prioritized: Array<{ id: string, score: number, reason: string }>, heroImageId: string | null }}
 */
export function prioritizeMedia(assets, { campaignType, slotCount }) {
  const scored = assets.map((asset) => {
    let score = asset.qualityScore ?? 50;
    const reasons = [];

    if (asset.qualityLabel === "good") { score += 20; reasons.push("high quality"); }
    else if (asset.qualityLabel === "low") { score -= 20; reasons.push("low quality"); }

    const searchable = [
      (asset.filename || "").toLowerCase(),
      ...(asset.tags || []).map((t) => t.toLowerCase()),
      (asset.caption || "").toLowerCase(),
    ].join(" ");

    const hasExterior = /exterior|front|hero/.test(searchable);
    const hasInterior = /kitchen|living|interior/.test(searchable);
    const hasLifestyle = /backyard|neighborhood|lifestyle/.test(searchable);

    if (hasExterior) { score += 30; reasons.push("exterior/hero shot"); }
    if (hasInterior) { score += 15; reasons.push("interior feature"); }
    if (hasLifestyle) { score += 10; reasons.push("lifestyle imagery"); }

    if (reasons.length === 0) reasons.push("standard media");

    const primaryTag = hasExterior ? "exterior" : hasInterior ? "interior" : hasLifestyle ? "lifestyle" : "other";

    return { id: asset.id, score, reason: reasons.join(", "), hasExterior, _primaryTag: primaryTag };
  });

  scored.sort((a, b) => b.score - a.score);

  const tagCounts = {};
  for (const item of scored) {
    const count = (tagCounts[item._primaryTag] || 0) + 1;
    tagCounts[item._primaryTag] = count;
    if (count === 2) item.score -= 10;
    if (count >= 3) item.score -= 20;
  }

  scored.sort((a, b) => b.score - a.score);

  const heroCandidate = scored.find((s) => s.hasExterior);
  const heroImageId = heroCandidate?.id ?? (scored.length > 0 ? scored[0].id : null);

  return {
    prioritized: scored.map(({ id, score, reason }) => ({ id, score, reason })),
    heroImageId,
  };
}

// ── 4. buildIntelligentSchedule ─────────────────────────────────────────

// Inline preset slot definitions (mirrors frontend schedulePresets.ts)
const PRESET_SLOTS = {
  balanced: [
    { id: "slot-1", label: "Launch Announcement", channel: "INSTAGRAM", campaignDay: 1 },
    { id: "slot-2", label: "Feature Highlight", channel: "FACEBOOK", campaignDay: 2 },
    { id: "slot-3", label: "Lifestyle Story", channel: "INSTAGRAM", campaignDay: 3 },
    { id: "slot-4", label: "Authority / Social Proof", channel: "LINKEDIN", campaignDay: 5 },
    { id: "slot-5", label: "Final Push", channel: "FACEBOOK", campaignDay: 7 },
  ],
  aggressive: [
    { id: "slot-1", label: "Launch Announcement", channel: "INSTAGRAM", campaignDay: 1 },
    { id: "slot-2", label: "Feature Highlight", channel: "FACEBOOK", campaignDay: 1 },
    { id: "slot-3", label: "Lifestyle Story", channel: "INSTAGRAM", campaignDay: 2 },
    { id: "slot-4", label: "Authority / Social Proof", channel: "LINKEDIN", campaignDay: 3 },
    { id: "slot-5", label: "Final Push", channel: "FACEBOOK", campaignDay: 4 },
  ],
  luxury: [
    { id: "slot-1", label: "Launch Announcement", channel: "INSTAGRAM", campaignDay: 1 },
    { id: "slot-2", label: "Lifestyle Story", channel: "INSTAGRAM", campaignDay: 3 },
    { id: "slot-3", label: "Feature Highlight", channel: "FACEBOOK", campaignDay: 5 },
    { id: "slot-4", label: "Authority / Social Proof", channel: "LINKEDIN", campaignDay: 7 },
    { id: "slot-5", label: "Final Push", channel: "FACEBOOK", campaignDay: 10 },
  ],
};

/**
 * Remap slots to only use available channels (round-robin fallback).
 */
function remapSlots(slots, channels) {
  if (channels.length === 0) return slots;
  return slots.map((slot, i) => {
    if (channels.includes(slot.channel)) return slot;
    const fallback = channels[i % channels.length];
    return { ...slot, channel: fallback };
  });
}

/**
 * @param {{ campaignType: string, channels: string[], propertyData: Record<string, unknown> }} input
 * @returns {{ preset: string, slots: Array, cadenceReason: string }}
 */
export function buildIntelligentSchedule({ campaignType, channels, propertyData }) {
  const price = propertyData.price;
  const daysOnMarket = propertyData.daysOnMarket;
  const isLuxury = typeof price === "number" && price >= 750000;

  let presetKey;
  let cadenceReason;

  switch (campaignType) {
    case "just_listed":
      if (isLuxury) {
        presetKey = "luxury";
        cadenceReason = "Luxury listing — slower storytelling builds exclusivity and anticipation";
      } else {
        presetKey = "aggressive";
        cadenceReason = "New listing — front-loaded schedule maximizes launch momentum";
      }
      break;
    case "open_house":
      presetKey = "aggressive";
      cadenceReason = "Open house — concentrated schedule drives attendance";
      break;
    case "price_drop":
      presetKey = "aggressive";
      cadenceReason = "Price reduction — fast cadence capitalizes on urgency";
      break;
    case "general_promotion":
      if (typeof daysOnMarket === "number" && daysOnMarket > 30) {
        presetKey = "luxury";
        cadenceReason = "Longer time on market — sustained pacing keeps interest alive";
      } else {
        presetKey = "balanced";
        cadenceReason = "Balanced cadence suits a general promotional campaign";
      }
      break;
    default:
      presetKey = "balanced";
      cadenceReason = "Balanced cadence suits a general promotional campaign";
  }

  let slots = remapSlots(PRESET_SLOTS[presetKey] || PRESET_SLOTS.balanced, channels);

  // Instagram gets Day 1
  if (channels.includes("INSTAGRAM")) {
    const igIdx = slots.findIndex((s) => s.channel === "INSTAGRAM");
    const day1Idx = slots.findIndex((s) => s.campaignDay === 1);
    if (igIdx !== -1 && day1Idx !== -1 && igIdx !== day1Idx) {
      const igCh = slots[igIdx].channel;
      const d1Ch = slots[day1Idx].channel;
      slots = slots.map((s, i) => {
        if (i === igIdx) return { ...s, channel: d1Ch };
        if (i === day1Idx) return { ...s, channel: igCh };
        return s;
      });
    }
  }

  // LinkedIn never on Day 1
  if (channels.includes("LINKEDIN")) {
    const d1LiIdx = slots.findIndex((s) => s.campaignDay === 1 && s.channel === "LINKEDIN");
    if (d1LiIdx !== -1) {
      const swapIdx = slots.findIndex((s, i) => i !== d1LiIdx && s.channel !== "LINKEDIN");
      if (swapIdx !== -1) {
        const liCh = slots[d1LiIdx].channel;
        const swCh = slots[swapIdx].channel;
        slots = slots.map((s, i) => {
          if (i === d1LiIdx) return { ...s, channel: swCh };
          if (i === swapIdx) return { ...s, channel: liCh };
          return s;
        });
      }
    }
  }

  return { preset: presetKey, slots, cadenceReason };
}

// ── 5. recommendMediaType ─────────────────────────────────────────────

const VIDEO_ALWAYS_CHANNELS = new Set(["YOUTUBE", "TIKTOK"]);

/**
 * Recommend whether a campaign slot should use image or video.
 *
 * @param {{ campaignType: string, channel: string, slotLabel: string, tier: string }} input
 * @returns {{ recommended: 'image' | 'video', reason: string }}
 */
export function recommendMediaType({ campaignType, channel, slotLabel, tier }) {
  // YouTube and TikTok always prefer video
  if (VIDEO_ALWAYS_CHANNELS.has(channel)) {
    return { recommended: "video", reason: `${channel} is a video-first platform` };
  }

  // PRO+ tiers get video recommendations for launch/showcase content
  const isPro = tier && !["FREE", "STARTER"].includes(tier.toUpperCase());
  const isLaunchContext = ["just_listed", "open_house"].includes(campaignType) ||
    /launch|showcase|walkthrough/i.test(slotLabel || "");

  if (isPro && isLaunchContext) {
    return { recommended: "video", reason: "Video performs best for launch and showcase content on your plan" };
  }

  return { recommended: "image", reason: "Image is the standard media type for this slot" };
}

// ── 6. VIDEO_CAMPAIGN_PRESETS ────────────────────────────────────────

/**
 * Maps campaign types to suggested video presets.
 */
export const VIDEO_CAMPAIGN_PRESETS = {
  just_listed: "listing_walkthrough",
  open_house: "listing_walkthrough",
  price_drop: "brand_awareness",
  general_promotion: "brand_awareness",
};

// ── Helpers ─────────────────────────────────────────────────────────────

function formatPrice(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
