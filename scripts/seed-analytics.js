import { prisma } from "../prisma.js";

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
  const prefixes = {
    INSTAGRAM: "ig",
    LINKEDIN: "li",
    TIKTOK: "tt",
    FACEBOOK: "fb",
    YOUTUBE: "yt",
  };
  return `${prefixes[channel]}_seed_${String(i).padStart(3, "0")}`;
}

// ── Post templates ───────────────────────────────────────────────────────────

const POST_TEMPLATES = [
  // Educational (high engagement target)
  {
    contentType: "educational",
    bodies: [
      "5 things every first-time homebuyer in Austin needs to know before making an offer. Thread below 👇\n\n1. Get pre-approved BEFORE you start looking\n2. Understand the difference between pre-qualification and pre-approval\n3. Budget for closing costs (2-5% of purchase price)\n4. Don't make large purchases before closing\n5. Work with a local agent who knows the market\n\nSave this for later!",
      "The hidden costs of homeownership nobody talks about:\n\n• Property taxes (Austin avg: $8,000-15,000/yr)\n• HOA fees ($200-600/mo in many communities)\n• Home insurance ($1,500-3,000/yr)\n• Maintenance reserve (1% of home value annually)\n• Utility costs (30-50% higher than renting)\n\nKnowing these upfront prevents buyer's remorse.",
      "How to read a home inspection report like a pro:\n\nRed flags that are dealbreakers:\n→ Foundation issues\n→ Roof damage requiring full replacement\n→ Electrical panel deficiencies\n→ Active water damage / mold\n\nNegotiable items:\n→ HVAC age (ask for credit)\n→ Minor plumbing fixes\n→ Cosmetic issues\n\nDon't let a long report scare you — context matters.",
      "Austin market update: What the data actually tells us this month.\n\nMedian home price: $485,000 (down 2% MoM)\nAverage days on market: 45 (up from 38)\nInventory: 2.8 months supply\nNew listings: +12% vs last month\n\nWhat this means for buyers: More negotiating power.\nWhat this means for sellers: Price it right from day one.",
      "Understanding mortgage rates in 2025:\n\nFixed vs ARM — which is right for you?\n\n30-year fixed: Stability, higher rate\n15-year fixed: Lower rate, higher payment\n5/1 ARM: Lower initial rate, risk after 5 years\n\nIf you plan to stay 7+ years → go fixed.\nIf you plan to move in 3-5 years → ARM could save you thousands.\n\nAlways run the numbers with your lender.",
      "Staging your home to sell faster: 7 data-backed tips\n\n1. Declutter every room (buyers need to envision their life)\n2. Neutral paint colors increase offers by 6%\n3. Professional photos get 2x more online views\n4. Price homes that sit lose leverage\n5. Fresh landscaping adds 5-12% perceived value\n6. Remove personal photos during showings\n7. Clean like you've never cleaned before\n\nFirst impressions are everything in real estate.",
    ],
    hooks: [
      ["5 things every first-time homebuyer needs to know"],
      ["The hidden costs nobody talks about"],
      ["How to read this like a pro"],
      ["What the data actually tells us"],
      ["Understanding rates in 2025"],
      ["7 data-backed tips to sell faster"],
    ],
    hashtags: [
      ["#AustinRealEstate", "#HomeBuyingTips", "#FirstTimeHomeBuyer"],
      ["#HomeownershipCosts", "#RealEstateTips", "#AustinTX"],
      ["#HomeInspection", "#BuyerTips", "#RealEstateEducation"],
      ["#MarketUpdate", "#AustinHousing", "#RealEstateData"],
      ["#MortgageRates", "#HomeBuying", "#FinanceTips"],
      ["#HomeStaging", "#SellYourHome", "#RealEstateMarketing"],
    ],
    ctas: [
      "Save this for when you start your home search!",
      "DM us for a free buyer consultation",
      "Comment GUIDE and we'll send you our free checklist",
      "Link in bio for the full market report",
      "Book a free 15-min call to discuss your options",
    ],
  },
  // Promotional
  {
    contentType: "promotional",
    bodies: [
      "JUST LISTED 🏡\n\n4 bed / 3 bath in Westlake Hills\n3,200 sq ft | Built 2021\nOpen floor plan with chef's kitchen\nPool + outdoor entertaining space\nWalk to Barton Creek Greenbelt\n\n$875,000\n\nOpen house this Saturday 1-4pm.\nDM for details or to schedule a private showing.",
      "✨ UNDER CONTRACT in 4 days!\n\nThis stunning Tarrytown bungalow received 6 offers above asking.\n\nListed at $625,000\nPending at $671,000 (+7.4%)\n\nOur marketing strategy:\n→ Pre-listing buzz campaign\n→ Professional twilight photography\n→ 3D virtual tour\n→ Targeted social media ads\n\nThinking of selling? Let's talk about what your home is worth.",
      "JUST SOLD 🎉\n\n2847 Barton Skyway — $1,250,000\n\nOur clients found their dream home after a 3-month search. Modern hill country design, 5 bedrooms, and panoramic views of the Austin skyline.\n\nCongratulations to the Martinez family on their new home!\n\nLooking for your perfect Austin property? We'd love to help.",
      "New listing alert! 📍 Mueller neighborhood\n\n3 bed / 2.5 bath townhome\n1,800 sq ft | 2-car garage\nRooftop deck with downtown views\nWalking distance to shops & restaurants\n\nPriced at $525,000\n\nMueller is one of Austin's most walkable neighborhoods — perfect for young professionals and small families.",
      "PRICE IMPROVEMENT 🔑\n\n9102 Great Hills Trail\nNow offered at $749,000 (was $789,000)\n\n4 bed / 3.5 bath | 2,900 sq ft\nCompletely renovated kitchen & bathrooms\nOversize lot backing to greenbelt\nGreat Hills / Westwood school zone\n\nThis won't last at the new price. Schedule your showing today.",
    ],
    hooks: [
      ["Just listed in Westlake Hills"],
      ["Under contract in 4 days!"],
      ["Just sold — congratulations!"],
      ["New listing alert"],
      ["Price improvement you need to see"],
    ],
    hashtags: [
      ["#JustListed", "#AustinLuxury", "#WestlakeHills"],
      ["#UnderContract", "#Tarrytown", "#AustinRealEstate"],
      ["#JustSold", "#AustinHomes", "#DreamHome"],
      ["#Mueller", "#AustinTX", "#Townhome"],
      ["#PriceReduction", "#GreatHills", "#AustinHomes"],
    ],
    ctas: [
      "DM for details or to schedule a showing",
      "Thinking of selling? Let's talk strategy",
      "Comment TOUR for a virtual walkthrough link",
      "Link in bio for full listing details",
      "Call us today for a private showing",
    ],
  },
  // Story / behind the scenes
  {
    contentType: "story",
    bodies: [
      "Behind the scenes of yesterday's listing photoshoot 📸\n\nOur team spent 4 hours staging, styling, and shooting this lakefront property. The twilight shots turned out incredible.\n\nGreat listing photos aren't optional anymore — they're the #1 factor in getting buyers through the door.\n\nSwipe to see the before and after →",
      "A day in the life of an Austin realtor:\n\n6:30am — Morning run on Lady Bird Lake\n8:00am — Client meeting over coffee at Jo's\n9:30am — Showing 3 homes in South Austin\n12:00pm — Lunch & market research\n1:30pm — Listing presentation prep\n3:00pm — Home inspection with buyers\n5:00pm — Contract negotiations\n7:00pm — Finally dinner 😅\n\nNo two days are the same and that's why I love this job.",
      "This house almost didn't sell.\n\nIt sat on the market for 67 days with another agent. When the sellers came to us, we identified 3 problems:\n\n1. Overpriced by $40K based on comps\n2. Photos were taken on a phone\n3. No marketing beyond the MLS\n\nWe re-staged, hired a professional photographer, ran targeted ads, and adjusted the price. Result? Multiple offers in 10 days.\n\nThe right strategy makes all the difference.",
      "Handing over keys never gets old 🔑\n\nToday we helped the Johnsons close on their first home in East Austin. They came to us stressed and overwhelmed — 8 months later, they're homeowners.\n\nThe best part of this job is turning a daunting process into an exciting journey.\n\nCongrats, Johnson family! Welcome home.",
      "Our office just hit a milestone: 200 families helped this year! 🎊\n\nFrom first-time buyers to luxury sellers, every transaction is a story. Here are a few highlights:\n\n→ 47 first-time buyers got their keys\n→ Average days to close: 32\n→ $156M in total transaction volume\n→ 98% client satisfaction rating\n\nThank you Austin for trusting us with your biggest investment.",
    ],
    hooks: [
      ["Behind the scenes of our photoshoot"],
      ["A day in the life of a realtor"],
      ["This house almost didn't sell"],
      ["Handing over keys never gets old"],
      ["We just hit a huge milestone"],
    ],
    hashtags: [
      ["#BehindTheScenes", "#RealEstateLife", "#ListingPhotos"],
      ["#DayInTheLife", "#AustinRealtor", "#RealEstateAgent"],
      ["#SuccessStory", "#HomeSelling", "#RealEstateMarketing"],
      ["#ClosingDay", "#FirstTimeHomebuyer", "#NewHome"],
      ["#Milestone", "#AustinRealEstate", "#Grateful"],
    ],
    ctas: [
      "Follow along for more behind-the-scenes content",
      "What's your favorite part of the homebuying journey?",
      "Tag someone who needs to see this",
      "DM us to start your home search",
      "Share your own closing day story in the comments!",
    ],
  },
  // Engagement / questions
  {
    contentType: "engagement",
    bodies: [
      "Hot take: Buying a home in Austin is still worth it in 2025.\n\nYes, prices are higher than 5 years ago. But:\n• Rent is $2,200+/mo for a 2BR\n• Mortgage rates are stabilizing\n• Austin job growth is top 5 nationally\n• No state income tax\n• Equity > rent receipts\n\nAgree or disagree? Drop your take below 👇",
      "POLL: What's the #1 thing you look for in a home?\n\nA) Location & neighborhood\nB) Size & layout\nC) Price & value\nD) Outdoor space\n\nComment your answer! We'll share the results next week.",
      "Real talk: What's your biggest fear about buying a home?\n\n😰 Making the wrong financial decision\n😰 The market crashing after you buy\n😰 Hidden problems with the house\n😰 The process being too complicated\n\nNo question is too basic — drop it below and we'll answer honestly.",
      "Which Austin neighborhood would you live in if money was no object?\n\n🏡 Westlake Hills — luxury hilltop living\n🌳 Tarrytown — classic charm near downtown\n🏙️ Rainey Street — urban energy\n🌊 Lakeway — lakefront paradise\n🎵 South Congress — eclectic & walkable\n\nTell us your pick!",
      "True or false: You need 20% down to buy a home.\n\n❌ FALSE!\n\nHere are actual minimum down payments:\n• Conventional: 3%\n• FHA: 3.5%\n• VA: 0%\n• USDA: 0%\n\nOn a $400K home, 3% down = $12,000 (not $80,000).\n\nDon't let this myth stop you from exploring your options.",
    ],
    hooks: [
      ["Hot take on Austin real estate"],
      ["Poll: What do you look for in a home?"],
      ["What's your biggest fear about buying?"],
      ["Which neighborhood would you choose?"],
      ["True or false about down payments"],
    ],
    hashtags: [
      ["#AustinRealEstate", "#HotTake", "#HomeBuying"],
      ["#Poll", "#HomeSearch", "#RealEstateQuestion"],
      ["#RealTalk", "#HomeBuyerFears", "#AskAnAgent"],
      ["#AustinNeighborhoods", "#DreamHome", "#ATX"],
      ["#MythBusting", "#HomeBuyingMyths", "#DownPayment"],
    ],
    ctas: [
      "Drop your take below!",
      "Comment your answer — we'll share results next week",
      "Ask your question in the comments",
      "Tell us your pick!",
      "Share this with someone who needs to hear it",
    ],
  },
  // Announcement
  {
    contentType: "announcement",
    bodies: [
      "BIG NEWS: We're expanding to San Antonio! 🎉\n\nAfter 6 years serving Austin, Prestige Properties Group is opening our second office in the Alamo City.\n\nSame white-glove service. Same results-driven marketing. New market.\n\nStay tuned for our grand opening event in March!",
      "We're hiring! Looking for licensed agents who are passionate about helping families find their dream homes.\n\nWhat we offer:\n✅ Industry-leading commission splits\n✅ Full marketing support\n✅ Mentorship program for new agents\n✅ Collaborative team culture\n\nDM us or visit our website to apply.",
      "Exciting update: We just launched our new client portal! 🚀\n\nNow you can:\n• Track your transaction in real-time\n• Access all documents in one place\n• Schedule showings directly\n• Message your agent instantly\n• Get automated market alerts\n\nOur clients deserve a modern, transparent experience. Link in bio to check it out.",
      "Mark your calendars! 📅\n\nPrestige Properties is hosting a FREE first-time homebuyer workshop.\n\n📍 The LINE Hotel, Austin\n📅 Saturday, March 22\n🕐 10am - 12pm\n\nTopics covered:\n→ How to get pre-approved\n→ Understanding your budget\n→ What to expect at closing\n→ Q&A with our team + a mortgage lender\n\nSeats are limited — register at the link in our bio.",
    ],
    hooks: [
      ["Big news for Prestige Properties"],
      ["We're hiring passionate agents"],
      ["Exciting update for our clients"],
      ["Mark your calendars for this event"],
    ],
    hashtags: [
      ["#BigNews", "#SanAntonio", "#Expansion"],
      ["#Hiring", "#RealEstateCareer", "#JoinOurTeam"],
      ["#TechUpdate", "#ClientExperience", "#RealEstateTech"],
      ["#FreeWorkshop", "#HomeBuyerEvent", "#AustinEvents"],
    ],
    ctas: [
      "Follow us for updates on our San Antonio launch!",
      "DM us or visit our website to apply",
      "Link in bio to explore the new portal",
      "Register now — link in bio. Seats are limited!",
    ],
  },
];

// ── Draft generation config ──────────────────────────────────────────────────

// Channel distribution: INSTAGRAM 20, LINKEDIN 15, TIKTOK 10, FACEBOOK 10, YOUTUBE 5
const CHANNEL_POOL = [
  ...Array(20).fill("INSTAGRAM"),
  ...Array(15).fill("LINKEDIN"),
  ...Array(10).fill("TIKTOK"),
  ...Array(10).fill("FACEBOOK"),
  ...Array(5).fill("YOUTUBE"),
];

// Media type distribution per channel
const MEDIA_TYPE_WEIGHTS = {
  INSTAGRAM: ["image", "image", "image", "carousel", "carousel", "video"],
  LINKEDIN: ["text", "text", "image", "image", "video"],
  TIKTOK: ["video", "video", "video", "video"],
  FACEBOOK: ["image", "image", "text", "video", "carousel"],
  YOUTUBE: ["video", "video", "video"],
};

// Posting hours — morning posts should dominate for timing signal
const POSTING_HOURS = {
  morning: [6, 7, 8],
  midday: [9, 10, 11],
  afternoon: [13, 14, 15],
  evening: [18, 19],
};

function getPostingHour(dayIndex) {
  // 55% morning, 20% midday, 15% afternoon, 10% evening
  const r = Math.random();
  if (r < 0.55) return pick(POSTING_HOURS.morning);
  if (r < 0.75) return pick(POSTING_HOURS.midday);
  if (r < 0.9) return pick(POSTING_HOURS.afternoon);
  return pick(POSTING_HOURS.evening);
}

// ── Metrics generation ───────────────────────────────────────────────────────

// Platform baseline metrics (realistic ranges)
const PLATFORM_BASELINES = {
  INSTAGRAM: { impressionsMin: 800, impressionsMax: 12000, engagementRateBase: 3.2 },
  LINKEDIN: { impressionsMin: 500, impressionsMax: 8000, engagementRateBase: 4.0 },
  TIKTOK: { impressionsMin: 1500, impressionsMax: 30000, engagementRateBase: 5.0 },
  FACEBOOK: { impressionsMin: 400, impressionsMax: 6000, engagementRateBase: 2.5 },
  YOUTUBE: { impressionsMin: 300, impressionsMax: 15000, engagementRateBase: 3.0 },
};

// Score tier targets: ~10 exceptional (85+), ~30 average (40-70), ~5 below 30, rest strong
function assignScoreTier(index) {
  if (index < 10) return "exceptional"; // 85-98
  if (index < 17) return "strong"; // 70-84
  if (index < 47) return "average"; // 40-69
  if (index < 55) return "below_average"; // 30-49
  return "needs_attention"; // 10-29
}

function generatePerformanceScore(tier) {
  switch (tier) {
    case "exceptional":
      return randomBetween(85, 98);
    case "strong":
      return randomBetween(70, 84);
    case "average":
      return randomBetween(40, 69);
    case "below_average":
      return randomBetween(30, 49);
    case "needs_attention":
      return randomBetween(10, 29);
    default:
      return randomBetween(40, 60);
  }
}

function generateMetrics(channel, contentType, mediaType, scoreTier) {
  const baseline = PLATFORM_BASELINES[channel];

  // Engagement rate multipliers
  let engagementMult = 1.0;

  // LinkedIn gets 15% higher avg scores (platform winner signal)
  if (channel === "LINKEDIN") engagementMult *= 1.15;

  // Educational posts perform best (content type winner signal)
  if (contentType === "educational") engagementMult *= 1.2;
  if (contentType === "engagement") engagementMult *= 1.1;

  // Video outperforms (media winner signal)
  if (mediaType === "video") engagementMult *= 1.15;
  if (mediaType === "carousel") engagementMult *= 1.05;

  // Score tier affects engagement
  const tierMult =
    scoreTier === "exceptional"
      ? 1.5
      : scoreTier === "strong"
        ? 1.2
        : scoreTier === "average"
          ? 0.9
          : scoreTier === "below_average"
            ? 0.6
            : 0.35;

  engagementMult *= tierMult;

  const impressions = randomBetween(baseline.impressionsMin, baseline.impressionsMax);
  const reach = Math.round(impressions * (0.6 + Math.random() * 0.35));
  const engagementRate = Math.max(
    0.1,
    baseline.engagementRateBase * engagementMult * (0.8 + Math.random() * 0.4)
  );
  const totalEngagements = Math.round((impressions * engagementRate) / 100);

  // Distribute engagements across metric types
  const likes = Math.round(totalEngagements * (0.45 + Math.random() * 0.2));
  const comments = Math.round(totalEngagements * (0.1 + Math.random() * 0.1));
  const shares = Math.round(totalEngagements * (0.05 + Math.random() * 0.1));
  const saves = Math.round(totalEngagements * (0.05 + Math.random() * 0.08));
  const clicks = Math.round(totalEngagements * (0.1 + Math.random() * 0.15));
  const engagement = likes + comments + shares + saves;

  return {
    impressions,
    reach,
    engagement,
    clicks,
    saves,
    shares,
    comments,
    likes,
    engagementRate: Math.round(engagementRate * 1000) / 1000,
  };
}

function generateRawMetricJson(channel, metrics) {
  // Simulate platform-specific raw API response
  switch (channel) {
    case "INSTAGRAM":
      return {
        id: "ig_" + Math.random().toString(36).substring(7),
        timestamp: new Date().toISOString(),
        like_count: metrics.likes,
        comments_count: metrics.comments,
        impressions: metrics.impressions,
        reach: metrics.reach,
        saved: metrics.saves,
        shares: metrics.shares,
        engagement: metrics.engagement,
        media_type: "IMAGE",
      };
    case "LINKEDIN":
      return {
        activity: "urn:li:activity:" + Math.random().toString(36).substring(7),
        totalShareStatistics: {
          shareCount: metrics.shares,
          clickCount: metrics.clicks,
          engagement: metrics.engagementRate / 100,
          impressionCount: metrics.impressions,
          likeCount: metrics.likes,
          commentCount: metrics.comments,
        },
      };
    case "TIKTOK":
      return {
        item_id: "tt_" + Math.random().toString(36).substring(7),
        desc: "Seeded post",
        statistics: {
          digg_count: metrics.likes,
          comment_count: metrics.comments,
          share_count: metrics.shares,
          play_count: metrics.impressions,
          collect_count: metrics.saves,
        },
      };
    case "FACEBOOK":
      return {
        id: "fb_" + Math.random().toString(36).substring(7),
        created_time: new Date().toISOString(),
        insights: {
          post_impressions: metrics.impressions,
          post_impressions_unique: metrics.reach,
          post_engaged_users: metrics.engagement,
          post_clicks: metrics.clicks,
        },
        reactions: { total_count: metrics.likes },
        comments: { total_count: metrics.comments },
        shares: { count: metrics.shares },
      };
    case "YOUTUBE":
      return {
        id: "yt_" + Math.random().toString(36).substring(7),
        statistics: {
          viewCount: String(metrics.impressions),
          likeCount: String(metrics.likes),
          dislikeCount: "0",
          commentCount: String(metrics.comments),
          favoriteCount: String(metrics.saves),
          shareCount: String(metrics.shares),
        },
      };
    default:
      return metrics;
  }
}

// ── Distribution of publish dates across 90 days ─────────────────────────────
// Weeks 1-4 (days 0-27): 5/wk = ~20 posts
// Weeks 5-8 (days 28-55): 2/wk = ~8 posts
// Weeks 9-12 (days 56-83): 4/wk = ~16 posts
// + a few extra scattered = ~57 published + 3 no-metrics = 60 total

function generatePublishDates(count) {
  const dates = [];
  // Weeks 1-4: high cadence (5/wk)
  for (let week = 0; week < 4; week++) {
    const weekDays = [1, 2, 3, 4, 5].map((d) => week * 7 + d);
    for (const dayOffset of weekDays) {
      if (dates.length < 20) {
        dates.push(90 - dayOffset); // days ago
      }
    }
  }
  // Weeks 5-8: low cadence (2/wk)
  for (let week = 4; week < 8; week++) {
    const weekDays = [2, 5].map((d) => week * 7 + d);
    for (const dayOffset of weekDays) {
      if (dates.length < 28) {
        dates.push(90 - dayOffset); // days ago
      }
    }
  }
  // Weeks 9-12: medium cadence (4/wk)
  for (let week = 8; week < 12; week++) {
    const weekDays = [1, 2, 4, 5].map((d) => week * 7 + d);
    for (const dayOffset of weekDays) {
      if (dates.length < count) {
        dates.push(90 - dayOffset); // days ago
      }
    }
  }
  // Fill remaining with random days
  while (dates.length < count) {
    dates.push(randomBetween(1, 85));
  }

  return dates.sort((a, b) => b - a); // most recent last
}

// ── Main seed function ───────────────────────────────────────────────────────

async function seedAnalytics() {
  console.log("🔍 Looking up Prestige Properties Group...");

  const client = await prisma.client.findUnique({
    where: { slug: "prestige-properties" },
  });

  if (!client) {
    console.error("❌ Client 'prestige-properties' not found. Run seed-realtor.js first.");
    process.exit(1);
  }

  const clientId = client.id;
  console.log(`✅ Found client: ${client.name} (${clientId})`);

  // ── Clean existing analytics data ──────────────────────────────────────────
  console.log("\n🧹 Cleaning existing analytics data...");

  // Delete in dependency order
  const deletedInsights = await prisma.postInsight.deleteMany({ where: { clientId } });
  const deletedNormalized = await prisma.normalizedMetric.deleteMany({ where: { clientId } });
  const deletedRaw = await prisma.rawMetric.deleteMany({ where: { clientId } });
  const deletedMetrics = await prisma.postMetrics.deleteMany({ where: { clientId } });
  const deletedSnapshots = await prisma.analyticsSnapshot.deleteMany({ where: { clientId } });
  const deletedWorkspace = await prisma.workspaceAnalytics.deleteMany({ where: { clientId } });

  // Delete old seeded PUBLISHED drafts (keep the originals from seed-realtor)
  const deletedDrafts = await prisma.draft.deleteMany({
    where: {
      clientId,
      status: "PUBLISHED",
      externalPostId: { startsWith: "ig_seed_" },
    },
  });
  // Also catch other prefixes
  for (const prefix of ["li_seed_", "tt_seed_", "fb_seed_", "yt_seed_"]) {
    await prisma.draft.deleteMany({
      where: {
        clientId,
        status: "PUBLISHED",
        externalPostId: { startsWith: prefix },
      },
    });
  }

  console.log(
    `   Deleted: ${deletedInsights.count} insights, ${deletedNormalized.count} normalized, ${deletedRaw.count} raw, ${deletedMetrics.count} metrics, ${deletedSnapshots.count} snapshots, ${deletedWorkspace.count} workspace`
  );

  // ── Create published drafts ────────────────────────────────────────────────
  console.log("\n📝 Creating published drafts...");

  const TOTAL_DRAFTS = 60;
  const NO_METRICS_COUNT = 3; // Last 3 drafts will have no metrics
  const publishDates = generatePublishDates(TOTAL_DRAFTS);

  // Shuffle channel pool to get our distribution
  const shuffledChannels = [...CHANNEL_POOL].sort(() => Math.random() - 0.5);

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
    const daysAgoVal = publishDates[i];
    const hour = getPostingHour(i);

    const publishedAt = daysAgo(daysAgoVal);
    publishedAt.setHours(hour, randomBetween(0, 59), 0, 0);

    const draft = await prisma.draft.create({
      data: {
        clientId,
        kind: mediaType === "carousel" ? "CAROUSEL" : mediaType === "video" ? "VIDEO_SCRIPT" : "POST",
        status: "PUBLISHED",
        channel,
        bucketKey: pick(["listings", "market-updates", "tips", "neighborhood", "behind-the-scenes"]),
        generationGuidance: "Seeded for analytics testing",
        body,
        hooks,
        hashtags,
        cta,
        mediaType,
        mediaUrl:
          mediaType === "text"
            ? null
            : `https://placeholder.test/seed/${channel.toLowerCase()}_${i}.${mediaType === "video" ? "mp4" : "jpg"}`,
        externalPostId: fakeExternalId(channel, i),
        publishedAt,
        publishSource: "seed",
        createdBy: "seed",
        approvedBy: "seed",
        approvedAt: new Date(publishedAt.getTime() - 3600000), // 1hr before publish
      },
    });

    createdDrafts.push({
      draft,
      channel,
      contentType: template.contentType,
      mediaType,
      scoreTier: assignScoreTier(i),
      hasMetrics: i < TOTAL_DRAFTS - NO_METRICS_COUNT,
    });
  }

  console.log(`   Created ${createdDrafts.length} published drafts`);

  // ── Create metrics for drafts (except last 3) ─────────────────────────────
  console.log("\n📊 Creating PostMetrics, RawMetric, NormalizedMetric, PostInsight...");

  let metricsCount = 0;
  let rawCount = 0;
  let normalizedCount = 0;
  let insightCount = 0;

  for (const item of createdDrafts) {
    const { draft, channel, contentType, mediaType, scoreTier, hasMetrics } = item;

    // PostInsight is created for ALL drafts (even without metrics)
    const score = hasMetrics ? generatePerformanceScore(scoreTier) : null;

    // Determine posting time bucket
    const hour = draft.publishedAt.getUTCHours();
    let postingTimeBucket = null;
    if (hour >= 5 && hour <= 8) postingTimeBucket = "morning";
    else if (hour >= 9 && hour <= 11) postingTimeBucket = "midday";
    else if (hour >= 12 && hour <= 16) postingTimeBucket = "afternoon";
    else if (hour >= 17 && hour <= 20) postingTimeBucket = "evening";
    else postingTimeBucket = "night";

    // Morning posts get a score boost (timing signal)
    const adjustedScore =
      score != null && postingTimeBucket === "morning"
        ? Math.min(100, score + randomBetween(3, 8))
        : score;

    const bodyLen = draft.body.length;
    const lengthBucket = bodyLen < 100 ? "short" : bodyLen > 500 ? "long" : "medium";

    // Determine hook type
    const firstLine = (draft.body.split("\n")[0] || "").toLowerCase();
    let hookType = "statement";
    if (firstLine.includes("?")) hookType = "question";
    else if (firstLine.includes("how to") || firstLine.includes("how do"))
      hookType = "how-to";
    else if (firstLine.includes("just listed") || firstLine.includes("just sold"))
      hookType = "direct_offer";
    else if (/^\d+\s/.test(firstLine)) hookType = "list";
    else if (firstLine.includes("hot take") || firstLine.includes("unpopular"))
      hookType = "controversial";
    else if (firstLine.includes("big news") || firstLine.includes("exciting"))
      hookType = "urgency";

    // Recommendation tags
    const recTags = [];
    if (!draft.cta) recTags.push("add-cta");
    if (mediaType === "text") recTags.push("add-visual");
    if (hookType === "statement") recTags.push("try-question-hook");
    if (bodyLen > 1500) recTags.push("shorten-copy");
    if (bodyLen < 80) recTags.push("write-longer");
    if (draft.hashtags.length === 0) recTags.push("add-hashtags");

    // Determine sentiment
    const positiveWords = ["love", "amazing", "exciting", "incredible", "congratulations", "dream", "perfect", "best", "great"];
    const negativeWords = ["fear", "problem", "stress", "overwhelm", "mistake", "hidden", "scary"];
    const bodyLower = draft.body.toLowerCase();
    const posCount = positiveWords.filter((w) => bodyLower.includes(w)).length;
    const negCount = negativeWords.filter((w) => bodyLower.includes(w)).length;
    const sentiment = posCount > negCount ? "positive" : negCount > posCount ? "negative" : "neutral";

    // Derive quality score from body heuristics, observed from engagement if available
    const seedQualityScore = adjustedScore != null ? Math.min(100, adjustedScore + randomBetween(-10, 10)) : null;
    const seedObservedScore = hasMetrics && adjustedScore != null ? Math.min(100, adjustedScore + randomBetween(-15, 15)) : null;

    await prisma.postInsight.create({
      data: {
        clientId,
        draftId: draft.id,
        qualityScore: seedQualityScore,
        observedScore: seedObservedScore,
        compositeScore: adjustedScore,
        contentType,
        hookType,
        sentiment,
        lengthBucket,
        mediaType,
        postingTimeBucket,
        recommendationTags: recTags,
      },
    });
    insightCount++;

    if (!hasMetrics) continue; // Skip metrics for last 3 drafts

    const metrics = generateMetrics(channel, contentType, mediaType, scoreTier);

    // PostMetrics
    await prisma.postMetrics.create({
      data: {
        draftId: draft.id,
        clientId,
        channel,
        ...metrics,
        lastSyncedAt: new Date(),
      },
    });
    metricsCount++;

    // RawMetric
    await prisma.rawMetric.create({
      data: {
        clientId,
        draftId: draft.id,
        channel,
        externalPostId: draft.externalPostId,
        dataJson: generateRawMetricJson(channel, metrics),
        fetchedAt: new Date(),
      },
    });
    rawCount++;

    // NormalizedMetric
    const avgEngagementRate =
      PLATFORM_BASELINES[channel].engagementRateBase;
    const relativeEngagementRate = metrics.engagementRate / avgEngagementRate;

    await prisma.normalizedMetric.create({
      data: {
        clientId,
        draftId: draft.id,
        channel,
        impressions: metrics.impressions,
        reach: metrics.reach,
        engagements: metrics.engagement,
        clicks: metrics.clicks,
        engagementRate: metrics.engagementRate,
        relativeEngagementRate: Math.round(relativeEngagementRate * 1000) / 1000,
      },
    });
    normalizedCount++;
  }

  console.log(`   PostMetrics: ${metricsCount}`);
  console.log(`   RawMetric: ${rawCount}`);
  console.log(`   NormalizedMetric: ${normalizedCount}`);
  console.log(`   PostInsight: ${insightCount}`);

  // ── Create WorkspaceAnalytics ──────────────────────────────────────────────
  console.log("\n📈 Creating WorkspaceAnalytics...");

  const allMetrics = await prisma.postMetrics.findMany({ where: { clientId } });
  const allInsights = await prisma.postInsight.findMany({
    where: { clientId, compositeScore: { not: null } },
  });

  const totalReach = allMetrics.reduce((sum, m) => sum + m.reach, 0);
  const totalEngagements = allMetrics.reduce((sum, m) => sum + m.engagement, 0);
  const avgEngagementRate =
    allMetrics.length > 0
      ? allMetrics.reduce((sum, m) => sum + (m.engagementRate || 0), 0) / allMetrics.length
      : 0;

  const safeAvg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const avgQualityScore = safeAvg(allInsights.map((i) => i.qualityScore).filter(Boolean));
  const observedValues = allInsights.map((i) => i.observedScore).filter((s) => s != null);
  const avgObservedScore = observedValues.length > 0 ? safeAvg(observedValues) : null;
  const avgCompositeScore = safeAvg(allInsights.map((i) => i.compositeScore).filter(Boolean));

  // Determine top platform by avg compositeScore
  const platformScores = {};
  for (const insight of allInsights) {
    const draft = createdDrafts.find((d) => d.draft.id === insight.draftId);
    if (!draft) continue;
    if (!platformScores[draft.channel]) platformScores[draft.channel] = [];
    platformScores[draft.channel].push(insight.compositeScore);
  }
  const topPlatform = Object.entries(platformScores)
    .map(([ch, scores]) => ({ ch, avg: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => b.avg - a.avg)[0]?.ch || null;

  // Determine best content type by avg compositeScore
  const contentTypeScores = {};
  for (const insight of allInsights) {
    if (!insight.contentType) continue;
    if (!contentTypeScores[insight.contentType]) contentTypeScores[insight.contentType] = [];
    contentTypeScores[insight.contentType].push(insight.compositeScore);
  }
  const bestContentType = Object.entries(contentTypeScores)
    .map(([ct, scores]) => ({ ct, avg: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => b.avg - a.avg)[0]?.ct || null;

  // Determine best media type by avg compositeScore
  const mediaTypeScores = {};
  for (const insight of allInsights) {
    if (!insight.mediaType) continue;
    if (!mediaTypeScores[insight.mediaType]) mediaTypeScores[insight.mediaType] = [];
    mediaTypeScores[insight.mediaType].push(insight.compositeScore);
  }
  const bestMediaType = Object.entries(mediaTypeScores)
    .map(([mt, scores]) => ({ mt, avg: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => b.avg - a.avg)[0]?.mt || null;

  await prisma.workspaceAnalytics.upsert({
    where: { clientId },
    create: {
      clientId,
      avgEngagementRate: Math.round(avgEngagementRate * 1000) / 1000,
      avgQualityScore: Math.round(avgQualityScore * 10) / 10,
      avgObservedScore: avgObservedScore != null ? Math.round(avgObservedScore * 10) / 10 : null,
      avgCompositeScore: Math.round(avgCompositeScore * 10) / 10,
      totalPosts: TOTAL_DRAFTS,
      totalPublishedPosts: TOTAL_DRAFTS,
      totalReach,
      totalEngagements,
      topPlatform,
      bestContentType,
      bestMediaType,
      lastCalculatedAt: new Date(),
    },
    update: {
      avgEngagementRate: Math.round(avgEngagementRate * 1000) / 1000,
      avgQualityScore: Math.round(avgQualityScore * 10) / 10,
      avgObservedScore: avgObservedScore != null ? Math.round(avgObservedScore * 10) / 10 : null,
      avgCompositeScore: Math.round(avgCompositeScore * 10) / 10,
      totalPosts: TOTAL_DRAFTS,
      totalPublishedPosts: TOTAL_DRAFTS,
      totalReach,
      totalEngagements,
      topPlatform,
      bestContentType,
      bestMediaType,
      lastCalculatedAt: new Date(),
    },
  });

  console.log(`   WorkspaceAnalytics created`);
  console.log(`     Avg engagement rate: ${(avgEngagementRate).toFixed(3)}%`);
  console.log(`     Avg composite score: ${avgCompositeScore.toFixed(1)}`);
  console.log(`     Total reach: ${totalReach.toLocaleString()}`);
  console.log(`     Top platform: ${topPlatform}`);
  console.log(`     Best content type: ${bestContentType}`);
  console.log(`     Best media type: ${bestMediaType}`);

  // ── Create AnalyticsSnapshots (last 30 days) ──────────────────────────────
  console.log("\n📅 Creating AnalyticsSnapshots (last 30 days)...");

  let snapshotCount = 0;

  for (let d = 29; d >= 0; d--) {
    const snapshotDate = daysAgo(d);
    snapshotDate.setHours(0, 0, 0, 0);

    // Accumulate metrics up to this date
    const postsUpToDate = createdDrafts.filter(
      (item) => item.draft.publishedAt <= snapshotDate && item.hasMetrics
    );

    if (postsUpToDate.length === 0) continue;

    const snapshotInsights = allInsights.filter((insight) =>
      postsUpToDate.some((p) => p.draft.id === insight.draftId)
    );
    const snapshotMetrics = allMetrics.filter((m) =>
      postsUpToDate.some((p) => p.draft.id === m.draftId)
    );

    const snapQuality = snapshotInsights.map((i) => i.qualityScore).filter(Boolean);
    const snapObserved = snapshotInsights.map((i) => i.observedScore).filter((s) => s != null);
    const snapComposite = snapshotInsights.map((i) => i.compositeScore).filter(Boolean);
    const snapAvgQuality = snapQuality.length > 0 ? snapQuality.reduce((a, b) => a + b, 0) / snapQuality.length : 0;
    const snapAvgObserved = snapObserved.length > 0 ? snapObserved.reduce((a, b) => a + b, 0) / snapObserved.length : null;
    const snapAvgComposite = snapComposite.length > 0 ? snapComposite.reduce((a, b) => a + b, 0) / snapComposite.length : 0;
    const snapAvgER =
      snapshotMetrics.length > 0
        ? snapshotMetrics.reduce((s, m) => s + (m.engagementRate || 0), 0) / snapshotMetrics.length
        : 0;
    const snapReach = snapshotMetrics.reduce((s, m) => s + m.reach, 0);
    const snapEngagements = snapshotMetrics.reduce((s, m) => s + m.engagement, 0);

    await prisma.analyticsSnapshot.upsert({
      where: {
        clientId_snapshotDate: { clientId, snapshotDate },
      },
      create: {
        clientId,
        snapshotDate,
        avgQualityScore: Math.round(snapAvgQuality * 10) / 10,
        avgObservedScore: snapAvgObserved != null ? Math.round(snapAvgObserved * 10) / 10 : null,
        avgCompositeScore: Math.round(snapAvgComposite * 10) / 10,
        avgEngagementRate: Math.round(snapAvgER * 1000) / 1000,
        totalPosts: postsUpToDate.length,
        totalReach: snapReach,
        totalEngagements: snapEngagements,
      },
      update: {
        avgQualityScore: Math.round(snapAvgQuality * 10) / 10,
        avgObservedScore: snapAvgObserved != null ? Math.round(snapAvgObserved * 10) / 10 : null,
        avgCompositeScore: Math.round(snapAvgComposite * 10) / 10,
        avgEngagementRate: Math.round(snapAvgER * 1000) / 1000,
        totalPosts: postsUpToDate.length,
        totalReach: snapReach,
        totalEngagements: snapEngagements,
      },
    });
    snapshotCount++;
  }

  console.log(`   Created ${snapshotCount} daily snapshots`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n✅ Analytics seed complete!");
  console.log("─".repeat(50));
  console.log(`   Drafts:             ${TOTAL_DRAFTS} (${TOTAL_DRAFTS - NO_METRICS_COUNT} with metrics, ${NO_METRICS_COUNT} without)`);
  console.log(`   PostMetrics:        ${metricsCount}`);
  console.log(`   RawMetric:          ${rawCount}`);
  console.log(`   NormalizedMetric:   ${normalizedCount}`);
  console.log(`   PostInsight:        ${insightCount}`);
  console.log(`   WorkspaceAnalytics: 1`);
  console.log(`   AnalyticsSnapshots: ${snapshotCount}`);
  console.log("─".repeat(50));
  console.log("\nData patterns seeded:");
  console.log("  • LinkedIn has ~15% higher engagement (platform winner)");
  console.log("  • Educational posts get +20% engagement (content type winner)");
  console.log("  • Video posts outperform image/text (media winner)");
  console.log("  • 55% morning posts with score boost (timing signal)");
  console.log("  • Cadence: 5/wk → 2/wk → 4/wk (consistency variation)");
  console.log("  • Score tiers: ~10 exceptional, ~7 strong, ~30 average, ~8 below avg, ~5 needs attention");
  console.log("  • 3 drafts with no metrics (internal-only scoring fallback)");
}

seedAnalytics()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
