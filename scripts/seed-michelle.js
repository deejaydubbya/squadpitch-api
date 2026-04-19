import { prisma } from "../prisma.js";

// ── Config ──────────────────────────────────────────────────────────────────

const CLIENT_ID = "cmo5c3gbr0014schnsixrvbzz";
const DAYS_BACK = 150; // ~5 months
const TOTAL_DRAFTS = 120;
const NO_METRICS_COUNT = 5;
const TIMEZONE = "America/Chicago";

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setSeconds(0, 0);
  return d;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fakeExternalId(channel, i) {
  const prefixes = { INSTAGRAM: "ig", LINKEDIN: "li", TIKTOK: "tt", FACEBOOK: "fb" };
  return `${prefixes[channel]}_mw_${String(i).padStart(3, "0")}`;
}

// ── Post templates (real estate agent) ─────────────────────────────────────

const POST_TEMPLATES = [
  {
    contentType: "educational",
    bodies: [
      "5 things every first-time homebuyer needs to know before making an offer:\n\n1. Get pre-approved BEFORE you start looking\n2. Budget for closing costs (2-5% of purchase price)\n3. Don't make large purchases before closing\n4. Research neighborhoods thoroughly\n5. Work with an agent who knows the local market\n\nSave this for later!",
      "The hidden costs of homeownership nobody tells you about:\n\n• Property taxes\n• HOA fees ($200-600/mo in many communities)\n• Home insurance\n• Maintenance reserve (1% of home value annually)\n• Utility costs (30-50% higher than renting)\n\nKnowing these upfront prevents buyer's remorse.",
      "How to read a home inspection report like a pro:\n\nDealbreakers:\n→ Foundation issues\n→ Roof needing full replacement\n→ Electrical panel problems\n→ Active water damage / mold\n\nNegotiable:\n→ HVAC age (ask for credit)\n→ Minor plumbing fixes\n→ Cosmetic issues\n\nContext matters — don't let a long report scare you.",
      "Market update: What the data actually tells us.\n\nMedian price: trending sideways\nDays on market: increasing slightly\nInventory: growing\nNew listings: up month over month\n\nBuyers: More negotiating power.\nSellers: Price it right from day one.",
      "Understanding mortgage rates:\n\nFixed vs ARM — which is right?\n\n30-year fixed: Stability, higher rate\n15-year fixed: Lower rate, higher payment\n5/1 ARM: Lower initial, risk after 5 years\n\nStaying 7+ years → go fixed.\nMoving in 3-5 years → ARM could save thousands.\n\nAlways run the numbers.",
      "Staging your home to sell faster — 7 tips:\n\n1. Declutter every room\n2. Neutral paint colors increase offers\n3. Professional photos get 2x more views\n4. Overpriced homes that sit lose leverage\n5. Fresh landscaping adds perceived value\n6. Remove personal photos\n7. Deep clean everything\n\nFirst impressions are everything.",
    ],
    hooks: [["5 things homebuyers need to know"], ["Hidden costs nobody mentions"], ["Read inspection reports like a pro"], ["Market data update"], ["Mortgage rate guide"], ["7 staging tips"]],
    hashtags: [["#RealEstate", "#HomeBuyingTips", "#FirstTimeHomeBuyer"], ["#HomeownershipCosts", "#RealEstateTips"], ["#HomeInspection", "#BuyerTips"], ["#MarketUpdate", "#Housing"], ["#MortgageRates", "#HomeBuying"], ["#HomeStaging", "#SellYourHome"]],
    ctas: ["Save this for your home search!", "DM me for a free consultation", "Comment GUIDE for our free checklist", "Link in bio for the full report", "Book a free call to discuss"],
  },
  {
    contentType: "promotional",
    bodies: [
      "JUST LISTED 🏡\n\n4 bed / 3 bath beauty\n3,200 sq ft | Updated kitchen\nPool + outdoor entertaining\nGreat school district\n\nOpen house this Saturday 1-4pm.\nDM for details or to schedule a private showing.",
      "✨ UNDER CONTRACT in 5 days!\n\nThis gorgeous home received multiple offers above asking.\n\nOur marketing strategy:\n→ Pre-listing buzz campaign\n→ Professional photography\n→ 3D virtual tour\n→ Targeted social ads\n\nThinking of selling? Let's talk about your home's value.",
      "JUST SOLD 🎉\n\nCongratulations to our amazing clients on their new home! Modern design, spacious layout, and the perfect neighborhood.\n\nLooking for your dream home? We'd love to help you find it.",
      "New listing alert! 📍\n\n3 bed / 2.5 bath\n1,800 sq ft | 2-car garage\nUpdated throughout\nWalkable to shops & restaurants\n\nThis won't last — schedule your showing today.",
      "PRICE IMPROVEMENT 🔑\n\nBeautiful home now at a new price!\n4 bed / 3.5 bath | 2,900 sq ft\nCompletely renovated\nOversize lot\nTop school zone\n\nSchedule your showing today.",
    ],
    hooks: [["Just listed — stunning home"], ["Under contract in 5 days!"], ["Just sold — congratulations!"], ["New listing alert"], ["Price improvement"]],
    hashtags: [["#JustListed", "#NewListing", "#DreamHome"], ["#UnderContract", "#RealEstateSuccess"], ["#JustSold", "#NewHome"], ["#Listing", "#HomeForSale"], ["#PriceReduction", "#Opportunity"]],
    ctas: ["DM for details or to schedule a showing", "Let's talk strategy for your home", "Comment TOUR for a virtual walkthrough", "Link in bio for full details", "Call today for a private showing"],
  },
  {
    contentType: "story",
    bodies: [
      "Behind the scenes of yesterday's listing photoshoot 📸\n\nOur team spent hours staging and shooting this property. The twilight shots turned out incredible.\n\nGreat listing photos aren't optional — they're the #1 factor in getting buyers through the door.",
      "A day in my life as a realtor:\n\n6:30am — Morning workout\n8:00am — Client meeting over coffee\n9:30am — Showing 3 homes\n12:00pm — Market research\n1:30pm — Listing prep\n3:00pm — Home inspection\n5:00pm — Contract negotiations\n7:00pm — Finally dinner 😅\n\nNo two days are the same!",
      "This house almost didn't sell.\n\nIt sat for 67 days with another agent. When the sellers came to me, I identified 3 problems:\n\n1. Overpriced by $40K\n2. Phone photos\n3. No marketing beyond MLS\n\nI re-staged, hired a photographer, ran targeted ads, and adjusted pricing. Multiple offers in 10 days.\n\nStrategy matters.",
      "Handing over keys never gets old 🔑\n\nToday I helped a family close on their first home. They came stressed and overwhelmed — now they're homeowners.\n\nTurning a daunting process into an exciting journey is the best part of my job.",
    ],
    hooks: [["Behind the scenes of our photoshoot"], ["A day in my life as a realtor"], ["This house almost didn't sell"], ["Handing over keys never gets old"]],
    hashtags: [["#BehindTheScenes", "#RealEstateLife"], ["#DayInTheLife", "#RealtorLife"], ["#SuccessStory", "#RealEstateMarketing"], ["#ClosingDay", "#NewHome"]],
    ctas: ["Follow for more behind-the-scenes!", "What's your favorite part of homebuying?", "Tag someone who needs to see this", "DM me to start your home search"],
  },
  {
    contentType: "engagement",
    bodies: [
      "Hot take: Buying a home is still worth it.\n\nYes prices are higher. But:\n• Rent keeps rising\n• Rates are stabilizing\n• Equity > rent receipts\n• Tax benefits still apply\n\nAgree or disagree? Drop your take below 👇",
      "POLL: What's #1 on your home wishlist?\n\nA) Location & neighborhood\nB) Size & layout\nC) Price & value\nD) Outdoor space\n\nComment your answer!",
      "Real talk: What's your biggest fear about buying a home?\n\n😰 Making the wrong financial decision\n😰 Market crashing after you buy\n😰 Hidden problems with the house\n😰 The process being too complicated\n\nDrop your question below — I'll answer honestly.",
      "True or false: You need 20% down to buy a home.\n\n❌ FALSE!\n\nMinimum down payments:\n• Conventional: 3%\n• FHA: 3.5%\n• VA: 0%\n• USDA: 0%\n\nDon't let this myth stop you.",
    ],
    hooks: [["Hot take on real estate"], ["Poll: What's on your wishlist?"], ["What's your biggest fear about buying?"], ["True or false about down payments"]],
    hashtags: [["#RealEstate", "#HotTake", "#HomeBuying"], ["#Poll", "#HomeSearch"], ["#RealTalk", "#HomeBuyerFears"], ["#MythBusting", "#DownPayment"]],
    ctas: ["Drop your take below!", "Comment your answer!", "Ask your question in the comments", "Share with someone who needs this"],
  },
  {
    contentType: "announcement",
    bodies: [
      "Exciting update: I just earned my luxury home certification! 🎓\n\nThis means even better service for clients in the luxury market. Honored to keep growing.",
      "We're hosting a FREE first-time homebuyer workshop! 📅\n\nTopics:\n→ Getting pre-approved\n→ Understanding your budget\n→ What to expect at closing\n→ Q&A with my team + a lender\n\nSeats are limited — DM me to register.",
      "Milestone: 50 families helped find their dream home this year! 🎉\n\nFrom first-time buyers to luxury sellers, every transaction is a story. Thank you for trusting me with your biggest investment.",
    ],
    hooks: [["Exciting certification update"], ["Free homebuyer workshop"], ["50 families milestone"]],
    hashtags: [["#LuxuryRealEstate", "#Certification"], ["#HomeWorkshop", "#FirstTimeBuyer"], ["#Milestone", "#Grateful"]],
    ctas: ["Follow for more updates!", "DM to register — limited seats", "Share your own story in the comments!"],
  },
];

// ── Channel + media distribution ──────────────────────────────────────────

const CHANNEL_POOL = [
  ...Array(40).fill("INSTAGRAM"),
  ...Array(35).fill("LINKEDIN"),
  ...Array(25).fill("FACEBOOK"),
  ...Array(20).fill("TIKTOK"),
];

const MEDIA_TYPE_WEIGHTS = {
  INSTAGRAM: ["image", "image", "image", "carousel", "carousel", "video"],
  LINKEDIN: ["text", "text", "image", "image", "video"],
  TIKTOK: ["video", "video", "video", "video"],
  FACEBOOK: ["image", "image", "text", "video", "carousel"],
};

const PLATFORM_BASELINES = {
  INSTAGRAM: { impressionsMin: 800, impressionsMax: 12000, engagementRateBase: 3.2 },
  LINKEDIN: { impressionsMin: 500, impressionsMax: 8000, engagementRateBase: 4.0 },
  TIKTOK: { impressionsMin: 1500, impressionsMax: 30000, engagementRateBase: 5.0 },
  FACEBOOK: { impressionsMin: 400, impressionsMax: 6000, engagementRateBase: 2.5 },
};

// ── Score tiers ────────────────────────────────────────────────────────────

function assignScoreTier(index, total) {
  const pct = index / total;
  if (pct < 0.08) return "exceptional";
  if (pct < 0.20) return "strong";
  if (pct < 0.70) return "average";
  if (pct < 0.88) return "below_average";
  return "needs_attention";
}

function generateScore(tier) {
  switch (tier) {
    case "exceptional": return randomBetween(85, 98);
    case "strong": return randomBetween(70, 84);
    case "average": return randomBetween(40, 69);
    case "below_average": return randomBetween(30, 49);
    case "needs_attention": return randomBetween(10, 29);
    default: return randomBetween(40, 60);
  }
}

function generateMetrics(channel, contentType, mediaType, scoreTier) {
  const baseline = PLATFORM_BASELINES[channel];
  let engMult = 1.0;
  if (channel === "LINKEDIN") engMult *= 1.15;
  if (contentType === "educational") engMult *= 1.2;
  if (contentType === "engagement") engMult *= 1.1;
  if (mediaType === "video") engMult *= 1.15;
  if (mediaType === "carousel") engMult *= 1.05;

  const tierMult = scoreTier === "exceptional" ? 1.5 : scoreTier === "strong" ? 1.2 : scoreTier === "average" ? 0.9 : scoreTier === "below_average" ? 0.6 : 0.35;
  engMult *= tierMult;

  const impressions = randomBetween(baseline.impressionsMin, baseline.impressionsMax);
  const reach = Math.round(impressions * (0.6 + Math.random() * 0.35));
  const engagementRate = Math.max(0.1, baseline.engagementRateBase * engMult * (0.8 + Math.random() * 0.4));
  const totalEngagements = Math.round((impressions * engagementRate) / 100);
  const likes = Math.round(totalEngagements * (0.45 + Math.random() * 0.2));
  const comments = Math.round(totalEngagements * (0.1 + Math.random() * 0.1));
  const shares = Math.round(totalEngagements * (0.05 + Math.random() * 0.1));
  const saves = Math.round(totalEngagements * (0.05 + Math.random() * 0.08));
  const clicks = Math.round(totalEngagements * (0.1 + Math.random() * 0.15));

  return { impressions, reach, engagement: likes + comments + shares + saves, clicks, saves, shares, comments, likes, engagementRate: Math.round(engagementRate * 1000) / 1000 };
}

// ── Campaign helpers ─────────────────────────────────────────────────

const CAMPAIGN_TYPES = ["just_listed", "open_house", "price_drop", "just_sold"];

function maybeCampaign(contentType, index) {
  // ~25% of promotional posts are campaigns
  if (contentType !== "promotional") return null;
  if (Math.random() > 0.6) return null;
  const type = pick(CAMPAIGN_TYPES);
  const total = randomBetween(3, 5);
  const day = randomBetween(1, total);
  return {
    campaignId: `campaign_mw_${type}_${Math.floor(index / 5)}`,
    campaignName: `${type.replace(/_/g, " ")} — ${daysAgo(randomBetween(0, 30)).toLocaleDateString()}`,
    campaignType: type,
    campaignDay: day,
    campaignOrder: day,
    campaignTotal: total,
  };
}

// ── Publish date distribution over 150 days ─────────────────────────────

function generatePublishDates(count) {
  const dates = [];
  // Generate roughly evenly but with cadence variation
  // Weeks 1-6 (days 0-41): 4/wk
  // Weeks 7-12 (days 42-83): 2/wk (dip)
  // Weeks 13-18 (days 84-125): 5/wk (peak)
  // Weeks 19-21 (days 126-150): 3/wk

  for (let week = 0; week < 6; week++) {
    for (const d of [1, 2, 4, 5]) dates.push(DAYS_BACK - (week * 7 + d));
  }
  for (let week = 6; week < 12; week++) {
    for (const d of [2, 4]) dates.push(DAYS_BACK - (week * 7 + d));
  }
  for (let week = 12; week < 18; week++) {
    for (const d of [1, 2, 3, 4, 5]) dates.push(DAYS_BACK - (week * 7 + d));
  }
  for (let week = 18; week < 22; week++) {
    for (const d of [1, 3, 5]) dates.push(DAYS_BACK - (week * 7 + d));
  }

  // Trim or fill to count
  while (dates.length > count) dates.pop();
  while (dates.length < count) dates.push(randomBetween(1, DAYS_BACK - 5));

  return dates.filter((d) => d > 0).sort((a, b) => b - a);
}

// ── Posting hours ─────────────────────────────────────────────────────────

function getPostingHour() {
  const r = Math.random();
  if (r < 0.50) return pick([7, 8, 9]); // morning
  if (r < 0.70) return pick([10, 11]); // midday
  if (r < 0.85) return pick([13, 14, 15]); // afternoon
  return pick([18, 19]); // evening
}

// ── Main ─────────────────────────────────────────────────────────────────

async function seed() {
  console.log("🔍 Looking up Michelle Weadbrock workspace...");

  const client = await prisma.client.findUnique({ where: { id: CLIENT_ID } });
  if (!client) { console.error("❌ Client not found"); process.exit(1); }

  console.log(`✅ Found: ${client.name} (${CLIENT_ID})`);

  // ── Set timezone ────────────────────────────────────────────────────────
  await prisma.client.update({ where: { id: CLIENT_ID }, data: { timezone: TIMEZONE } });
  console.log(`   Timezone set to ${TIMEZONE}`);

  // ── Populate brand profile ──────────────────────────────────────────────
  console.log("\n👤 Populating brand profile...");
  await prisma.brandProfile.upsert({
    where: { clientId: CLIENT_ID },
    create: {
      clientId: CLIENT_ID,
      description: "Michelle Weadbrock is a results-driven real estate agent helping families buy and sell homes with confidence. Known for her market expertise, responsive communication, and personalized approach, Michelle turns the stress of real estate into an exciting journey.",
      industry: "real_estate",
      audience: "First-time homebuyers, move-up buyers, downsizers, and sellers in the greater metro area. Primarily 28-55 year old professionals and families.",
      website: "https://michelleweadbrock.com",
      socialsJson: { instagram: "@michelleweadbrock", linkedin: "michelle-weadbrock", facebook: "MichelleWeadbrockRealEstate", tiktok: "@michellesellshomes" },
      offers: "Free home valuations, buyer consultations, relocation assistance, luxury home services, investment property guidance",
      competitors: "Local boutique brokerages, national franchise agents, iBuyers (Opendoor, Offerpad)",
      examplePosts: [],
      city: "Austin",
      state: "TX",
      marketArea: "Greater Austin Metro",
      primaryZip: "78704",
      serviceAreas: ["Austin", "Round Rock", "Cedar Park", "Lakeway", "Westlake Hills", "Bee Cave", "Pflugerville"],
    },
    update: {
      description: "Michelle Weadbrock is a results-driven real estate agent helping families buy and sell homes with confidence. Known for her market expertise, responsive communication, and personalized approach, Michelle turns the stress of real estate into an exciting journey.",
      industry: "real_estate",
      audience: "First-time homebuyers, move-up buyers, downsizers, and sellers in the greater metro area. Primarily 28-55 year old professionals and families.",
      website: "https://michelleweadbrock.com",
      socialsJson: { instagram: "@michelleweadbrock", linkedin: "michelle-weadbrock", facebook: "MichelleWeadbrockRealEstate", tiktok: "@michellesellshomes" },
      offers: "Free home valuations, buyer consultations, relocation assistance, luxury home services, investment property guidance",
      competitors: "Local boutique brokerages, national franchise agents, iBuyers (Opendoor, Offerpad)",
      city: "Austin",
      state: "TX",
      marketArea: "Greater Austin Metro",
      primaryZip: "78704",
      serviceAreas: ["Austin", "Round Rock", "Cedar Park", "Lakeway", "Westlake Hills", "Bee Cave", "Pflugerville"],
    },
  });
  console.log("   Brand profile populated");

  // ── Clean old seed data ─────────────────────────────────────────────────
  console.log("\n🧹 Cleaning existing analytics data...");

  await prisma.postMetricSnapshot.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.postInsight.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.normalizedMetric.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.rawMetric.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.postMetrics.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.analyticsSnapshot.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.workspaceAnalytics.deleteMany({ where: { clientId: CLIENT_ID } });

  // Delete old seeded PUBLISHED drafts
  for (const prefix of ["ig_mw_", "li_mw_", "tt_mw_", "fb_mw_"]) {
    await prisma.draft.deleteMany({ where: { clientId: CLIENT_ID, status: "PUBLISHED", externalPostId: { startsWith: prefix } } });
  }

  console.log("   Cleaned");

  // ── Create published drafts ─────────────────────────────────────────────
  console.log("\n📝 Creating published drafts...");

  const publishDates = generatePublishDates(TOTAL_DRAFTS);
  const shuffledChannels = [...CHANNEL_POOL].sort(() => Math.random() - 0.5).slice(0, TOTAL_DRAFTS);
  const createdDrafts = [];

  for (let i = 0; i < TOTAL_DRAFTS; i++) {
    const channel = shuffledChannels[i];
    const template = pick(POST_TEMPLATES);
    const bodyIndex = Math.floor(Math.random() * template.bodies.length);
    const body = template.bodies[bodyIndex];
    const hooks = template.hooks[Math.min(bodyIndex, template.hooks.length - 1)];
    const hashtags = template.hashtags[Math.min(bodyIndex, template.hashtags.length - 1)];
    const cta = pick(template.ctas);
    const mediaType = pick(MEDIA_TYPE_WEIGHTS[channel]);
    const daysAgoVal = publishDates[i] || randomBetween(1, DAYS_BACK);
    const hour = getPostingHour();

    const publishedAt = daysAgo(daysAgoVal);
    publishedAt.setHours(hour, randomBetween(0, 59), 0, 0);

    const campaign = maybeCampaign(template.contentType, i);

    const draft = await prisma.draft.create({
      data: {
        clientId: CLIENT_ID,
        kind: mediaType === "carousel" ? "CAROUSEL" : mediaType === "video" ? "VIDEO_SCRIPT" : "POST",
        status: "PUBLISHED",
        channel,
        bucketKey: pick(["listings", "market-updates", "tips", "neighborhood", "behind-the-scenes"]),
        generationGuidance: "Seeded for analytics",
        body,
        hooks,
        hashtags,
        cta,
        mediaType,
        mediaUrl: mediaType === "text" ? null : `https://placeholder.test/seed/${channel.toLowerCase()}_${i}.${mediaType === "video" ? "mp4" : "jpg"}`,
        externalPostId: fakeExternalId(channel, i),
        publishedAt,
        publishSource: "seed",
        createdBy: "seed",
        approvedBy: "seed",
        approvedAt: new Date(publishedAt.getTime() - 3600000),
        ...(campaign || {}),
      },
    });

    createdDrafts.push({ draft, channel, contentType: template.contentType, mediaType, scoreTier: assignScoreTier(i, TOTAL_DRAFTS), hasMetrics: i < TOTAL_DRAFTS - NO_METRICS_COUNT });
  }

  console.log(`   Created ${createdDrafts.length} published drafts`);

  // ── Create metrics ─────────────────────────────────────────────────────
  console.log("\n📊 Creating metrics...");

  let metricsCount = 0, rawCount = 0, normalizedCount = 0, insightCount = 0, snapshotCount = 0;

  for (const item of createdDrafts) {
    const { draft, channel, contentType, mediaType, scoreTier, hasMetrics } = item;
    const score = hasMetrics ? generateScore(scoreTier) : null;

    const hour = draft.publishedAt.getUTCHours();
    let postingTimeBucket = "night";
    if (hour >= 5 && hour <= 8) postingTimeBucket = "morning";
    else if (hour >= 9 && hour <= 11) postingTimeBucket = "midday";
    else if (hour >= 12 && hour <= 16) postingTimeBucket = "afternoon";
    else if (hour >= 17 && hour <= 20) postingTimeBucket = "evening";

    const adjustedScore = score != null && postingTimeBucket === "morning" ? Math.min(100, score + randomBetween(3, 8)) : score;
    const bodyLen = draft.body.length;
    const lengthBucket = bodyLen < 100 ? "short" : bodyLen > 500 ? "long" : "medium";

    const firstLine = (draft.body.split("\n")[0] || "").toLowerCase();
    let hookType = "statement";
    if (firstLine.includes("?")) hookType = "question";
    else if (firstLine.includes("how to")) hookType = "how-to";
    else if (firstLine.includes("just listed") || firstLine.includes("just sold")) hookType = "direct_offer";
    else if (/^\d+\s/.test(firstLine)) hookType = "list";
    else if (firstLine.includes("hot take")) hookType = "controversial";
    else if (firstLine.includes("big news") || firstLine.includes("exciting")) hookType = "urgency";

    const recTags = [];
    if (!draft.cta) recTags.push("add-cta");
    if (mediaType === "text") recTags.push("add-visual");
    if (hookType === "statement") recTags.push("try-question-hook");

    const positiveWords = ["love", "amazing", "exciting", "incredible", "congratulations", "dream", "perfect", "best", "great"];
    const negativeWords = ["fear", "problem", "stress", "overwhelm", "mistake", "hidden", "scary"];
    const bodyLower = draft.body.toLowerCase();
    const posCount = positiveWords.filter((w) => bodyLower.includes(w)).length;
    const negCount = negativeWords.filter((w) => bodyLower.includes(w)).length;
    const sentiment = posCount > negCount ? "positive" : negCount > posCount ? "negative" : "neutral";

    const seedQualityScore = adjustedScore != null ? Math.min(100, adjustedScore + randomBetween(-10, 10)) : null;
    const seedObservedScore = hasMetrics && adjustedScore != null ? Math.min(100, adjustedScore + randomBetween(-15, 15)) : null;

    await prisma.postInsight.create({
      data: {
        clientId: CLIENT_ID, draftId: draft.id,
        qualityScore: seedQualityScore, observedScore: seedObservedScore, compositeScore: adjustedScore,
        contentType, hookType, sentiment, lengthBucket, mediaType, postingTimeBucket, recommendationTags: recTags,
      },
    });
    insightCount++;

    if (!hasMetrics) continue;

    const metrics = generateMetrics(channel, contentType, mediaType, scoreTier);

    await prisma.postMetrics.create({
      data: { draftId: draft.id, clientId: CLIENT_ID, channel, ...metrics, lastSyncedAt: new Date() },
    });
    metricsCount++;

    await prisma.rawMetric.create({
      data: { clientId: CLIENT_ID, draftId: draft.id, channel, externalPostId: draft.externalPostId, rawDataJson: { seeded: true, ...metrics }, fetchedAt: new Date() },
    });
    rawCount++;

    const avgER = PLATFORM_BASELINES[channel].engagementRateBase;
    await prisma.normalizedMetric.create({
      data: { clientId: CLIENT_ID, draftId: draft.id, channel, impressions: metrics.impressions, reach: metrics.reach, engagements: metrics.engagement, clicks: metrics.clicks, engagementRate: metrics.engagementRate, relativeEngagementRate: Math.round((metrics.engagementRate / avgER) * 1000) / 1000 },
    });
    normalizedCount++;

    // PostMetricSnapshot — simulate daily snapshots growing over time
    const daysSincePublish = Math.floor((Date.now() - draft.publishedAt.getTime()) / 86400000);
    const snapshotDays = Math.min(daysSincePublish, randomBetween(3, 14));
    for (let s = 0; s < snapshotDays; s++) {
      const snapshotAt = new Date(draft.publishedAt.getTime() + (s + 1) * 86400000);
      snapshotAt.setHours(0, 0, 0, 0);
      const growth = 1 + (s * 0.08); // metrics grow over time
      await prisma.postMetricSnapshot.upsert({
        where: { draftId_snapshotAt: { draftId: draft.id, snapshotAt } },
        create: {
          draftId: draft.id, clientId: CLIENT_ID, channel, snapshotAt,
          impressions: Math.round(metrics.impressions * growth),
          reach: Math.round(metrics.reach * growth),
          engagements: Math.round(metrics.engagement * growth),
          clicks: Math.round(metrics.clicks * growth),
          saves: metrics.saves, shares: metrics.shares, comments: metrics.comments, likes: Math.round(metrics.likes * growth),
          engagementRate: metrics.engagementRate,
        },
        update: {},
      });
      snapshotCount++;
    }
  }

  console.log(`   PostMetrics: ${metricsCount}`);
  console.log(`   RawMetric: ${rawCount}`);
  console.log(`   NormalizedMetric: ${normalizedCount}`);
  console.log(`   PostInsight: ${insightCount}`);
  console.log(`   PostMetricSnapshot: ${snapshotCount}`);

  // ── WorkspaceAnalytics ─────────────────────────────────────────────────
  console.log("\n📈 Creating WorkspaceAnalytics...");

  const allMetrics = await prisma.postMetrics.findMany({ where: { clientId: CLIENT_ID } });
  const allInsights = await prisma.postInsight.findMany({ where: { clientId: CLIENT_ID, compositeScore: { not: null } } });

  const safeAvg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const totalReach = allMetrics.reduce((s, m) => s + m.reach, 0);
  const totalEngagements = allMetrics.reduce((s, m) => s + m.engagement, 0);

  await prisma.workspaceAnalytics.upsert({
    where: { clientId: CLIENT_ID },
    create: {
      clientId: CLIENT_ID,
      avgEngagementRate: Math.round(safeAvg(allMetrics.map((m) => m.engagementRate || 0)) * 1000) / 1000,
      avgQualityScore: Math.round(safeAvg(allInsights.map((i) => i.qualityScore).filter(Boolean)) * 10) / 10,
      avgObservedScore: Math.round(safeAvg(allInsights.map((i) => i.observedScore).filter(Boolean)) * 10) / 10,
      avgCompositeScore: Math.round(safeAvg(allInsights.map((i) => i.compositeScore).filter(Boolean)) * 10) / 10,
      totalPosts: TOTAL_DRAFTS, totalPublishedPosts: TOTAL_DRAFTS, totalReach, totalEngagements,
      topPlatform: "LINKEDIN", bestContentType: "educational", bestMediaType: "video",
      lastCalculatedAt: new Date(),
    },
    update: {
      avgEngagementRate: Math.round(safeAvg(allMetrics.map((m) => m.engagementRate || 0)) * 1000) / 1000,
      avgQualityScore: Math.round(safeAvg(allInsights.map((i) => i.qualityScore).filter(Boolean)) * 10) / 10,
      avgObservedScore: Math.round(safeAvg(allInsights.map((i) => i.observedScore).filter(Boolean)) * 10) / 10,
      avgCompositeScore: Math.round(safeAvg(allInsights.map((i) => i.compositeScore).filter(Boolean)) * 10) / 10,
      totalPosts: TOTAL_DRAFTS, totalPublishedPosts: TOTAL_DRAFTS, totalReach, totalEngagements,
      topPlatform: "LINKEDIN", bestContentType: "educational", bestMediaType: "video",
      lastCalculatedAt: new Date(),
    },
  });
  console.log("   WorkspaceAnalytics created");

  // ── AnalyticsSnapshots (last 90 days) ──────────────────────────────────
  console.log("\n📅 Creating AnalyticsSnapshots (90 days)...");

  let aSnapshotCount = 0;
  for (let d = 89; d >= 0; d--) {
    const snapshotDate = daysAgo(d);
    snapshotDate.setHours(0, 0, 0, 0);

    const postsUpToDate = createdDrafts.filter((item) => item.draft.publishedAt <= snapshotDate && item.hasMetrics);
    if (postsUpToDate.length === 0) continue;

    const snapInsights = allInsights.filter((i) => postsUpToDate.some((p) => p.draft.id === i.draftId));
    const snapMetrics = allMetrics.filter((m) => postsUpToDate.some((p) => p.draft.id === m.draftId));

    await prisma.analyticsSnapshot.upsert({
      where: { clientId_snapshotDate: { clientId: CLIENT_ID, snapshotDate } },
      create: {
        clientId: CLIENT_ID, snapshotDate,
        avgQualityScore: Math.round(safeAvg(snapInsights.map((i) => i.qualityScore).filter(Boolean)) * 10) / 10,
        avgObservedScore: Math.round(safeAvg(snapInsights.map((i) => i.observedScore).filter(Boolean)) * 10) / 10,
        avgCompositeScore: Math.round(safeAvg(snapInsights.map((i) => i.compositeScore).filter(Boolean)) * 10) / 10,
        avgEngagementRate: Math.round(safeAvg(snapMetrics.map((m) => m.engagementRate || 0)) * 1000) / 1000,
        totalPosts: postsUpToDate.length,
        totalReach: snapMetrics.reduce((s, m) => s + m.reach, 0),
        totalEngagements: snapMetrics.reduce((s, m) => s + m.engagement, 0),
      },
      update: {},
    });
    aSnapshotCount++;
  }

  console.log(`   Created ${aSnapshotCount} daily snapshots`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n✅ Seed complete!");
  console.log("─".repeat(50));
  console.log(`   Drafts:              ${TOTAL_DRAFTS} (${TOTAL_DRAFTS - NO_METRICS_COUNT} with metrics)`);
  console.log(`   PostMetrics:         ${metricsCount}`);
  console.log(`   NormalizedMetric:    ${normalizedCount}`);
  console.log(`   PostInsight:         ${insightCount}`);
  console.log(`   PostMetricSnapshot:  ${snapshotCount}`);
  console.log(`   AnalyticsSnapshots:  ${aSnapshotCount}`);
  console.log(`   Brand profile:       populated`);
  console.log(`   Timezone:            ${TIMEZONE}`);
  console.log("─".repeat(50));
}

seed()
  .catch((err) => { console.error("Seed failed:", err); process.exit(1); })
  .finally(() => prisma.$disconnect());
