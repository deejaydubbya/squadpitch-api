import { prisma } from "../prisma.js";

// ── Config ──────────────────────────────────────────────────────────────────

const CLIENT_ID = "cmo5c3gbr0014schnsixrvbzz";
const TOTAL_AUTOPILOT_DRAFTS = 25;

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
  const prefixes = { INSTAGRAM: "ig", LINKEDIN: "li", FACEBOOK: "fb", TIKTOK: "tt" };
  return `${prefixes[channel]}_ap_${String(i).padStart(3, "0")}`;
}

// ── Autopilot post templates ──────────────────────────────────────────────

const AUTOPILOT_TEMPLATES = [
  {
    trigger: "new_listing",
    reason: "New listing imported — auto-generated just listed post",
    angle: "Listing Spotlight",
    angleKey: "listing_spotlight",
    contentType: "promotional",
    bodies: [
      "✨ New on the market!\n\nBeautiful 4-bedroom home in a sought-after neighborhood. Updated kitchen, spacious backyard, and move-in ready.\n\nContact me for details or to schedule a showing!",
      "🏡 Just Listed!\n\nStunning 3 bed / 2 bath with modern finishes. Open floor plan, natural light, and a two-car garage.\n\nThis one won't last — reach out today!",
      "📍 NEW LISTING ALERT\n\nCharming home in a top-rated school district. 3 bedrooms, renovated bathrooms, and a beautiful backyard oasis.\n\nSchedule your private tour today!",
      "Fresh on the market! 🔑\n\n4 bed / 3.5 bath | 2,800 sq ft\nGourmet kitchen, hardwood floors, and a finished basement.\n\nOpen house this weekend — DM for details!",
    ],
    hooks: [["New on the market"], ["Just listed — stunning home"], ["New listing alert"], ["Fresh on the market"]],
    hashtags: [["#JustListed", "#NewListing", "#RealEstate"], ["#HomesForSale", "#DreamHome"], ["#NewListing", "#TopSchools"], ["#OpenHouse", "#HomeForSale"]],
  },
  {
    trigger: "new_review",
    reason: "New Google review received — auto-generated social proof post",
    angle: "Trust & Social Proof",
    angleKey: "trust_social_proof",
    contentType: "story",
    bodies: [
      "Another amazing review from a happy client! ⭐⭐⭐⭐⭐\n\n\"Working with Michelle was the best decision we made. She guided us through every step and found us the perfect home.\"\n\nThank you for trusting me with your biggest investment! 🙏",
      "Nothing makes my day like hearing from happy homeowners! ❤️\n\n\"Michelle made the entire process stress-free. Her market knowledge and negotiation skills saved us thousands.\"\n\nReady to start your home journey? Let's connect!",
      "5-star reviews are the highlight of my week ⭐\n\n\"From the first meeting to closing day, Michelle was professional, responsive, and genuinely cared about our needs.\"\n\nClient success is my biggest motivator.",
    ],
    hooks: [["5-star review from a happy client"], ["Happy homeowner feedback"], ["Another amazing review"]],
    hashtags: [["#ClientReview", "#5Stars", "#RealEstateAgent"], ["#HappyClients", "#Testimonial"], ["#ClientLove", "#RealEstateSuccess"]],
  },
  {
    trigger: "inactivity_gap",
    reason: "No content posted in 4 days — auto-generated engagement post",
    angle: "Buyer Guidance",
    angleKey: "buyer_guidance",
    contentType: "educational",
    bodies: [
      "Quick tip for buyers in today's market 💡\n\nDon't wait for prices to drop — they probably won't.\n\nInstead, focus on:\n→ Getting pre-approved now\n→ Finding the right neighborhood\n→ Understanding your monthly budget\n→ Building a relationship with a local agent\n\nTiming the market vs time IN the market — the data is clear.",
      "3 mistakes first-time buyers keep making:\n\n1. Not getting pre-approved first\n2. Skipping the home inspection\n3. Making emotional decisions without data\n\nAvoid these and your home search will be so much smoother.\n\nQuestions? Drop them below 👇",
      "What to look for during an open house 🏠\n\n✅ Check water pressure in all bathrooms\n✅ Look for signs of water damage\n✅ Open and close every window\n✅ Test all light switches\n✅ Walk the perimeter outside\n✅ Notice the neighborhood at different times\n\nSave this checklist for your next showing!",
    ],
    hooks: [["Quick buyer tip"], ["3 common buyer mistakes"], ["Open house checklist"]],
    hashtags: [["#BuyerTips", "#RealEstate", "#HomeBuying"], ["#FirstTimeBuyer", "#HomeSearch"], ["#OpenHouse", "#HomeBuyerTips"]],
  },
  {
    trigger: "new_milestone",
    reason: "Just sold milestone detected — auto-generated celebration post",
    angle: "Listing Spotlight",
    angleKey: "listing_spotlight",
    contentType: "promotional",
    bodies: [
      "🎉 JUST SOLD!\n\nAnother family in their dream home. This beautiful property closed above asking price in just 8 days on market.\n\nThinking of selling? Our marketing strategy delivers results. Let's chat!",
      "SOLD! 🔑\n\nCongratulations to my amazing clients on closing day! From start to finish, we worked as a team to get the best deal.\n\nYour next chapter starts now — so happy for you!",
    ],
    hooks: [["Just sold — above asking!"], ["Closing day celebration"]],
    hashtags: [["#JustSold", "#AboveAsking", "#RealEstateSuccess"], ["#ClosingDay", "#NewHomeowners"]],
  },
];

// ── Status distribution ────────────────────────────────────────────────────
// 12 PUBLISHED, 4 APPROVED, 3 PENDING_REVIEW, 3 DRAFT, 2 REJECTED, 1 SCHEDULED
const STATUS_DISTRIBUTION = [
  ...Array(12).fill("PUBLISHED"),
  ...Array(4).fill("APPROVED"),
  ...Array(3).fill("PENDING_REVIEW"),
  ...Array(3).fill("DRAFT"),
  ...Array(2).fill("REJECTED"),
  ...Array(1).fill("SCHEDULED"),
];

const CHANNELS = ["INSTAGRAM", "INSTAGRAM", "INSTAGRAM", "FACEBOOK", "FACEBOOK", "LINKEDIN", "LINKEDIN", "TIKTOK"];

const PLATFORM_BASELINES = {
  INSTAGRAM: { impressionsMin: 800, impressionsMax: 12000, engagementRateBase: 3.2 },
  LINKEDIN: { impressionsMin: 500, impressionsMax: 8000, engagementRateBase: 4.0 },
  TIKTOK: { impressionsMin: 1500, impressionsMax: 30000, engagementRateBase: 5.0 },
  FACEBOOK: { impressionsMin: 400, impressionsMax: 6000, engagementRateBase: 2.5 },
};

const MEDIA_TYPE_WEIGHTS = {
  INSTAGRAM: ["image", "image", "image", "carousel", "video"],
  LINKEDIN: ["text", "image", "image", "video"],
  TIKTOK: ["video", "video", "video"],
  FACEBOOK: ["image", "image", "text", "video"],
};

function generateMetrics(channel, contentType, mediaType) {
  const baseline = PLATFORM_BASELINES[channel];
  let engagementMult = 1.0;
  if (contentType === "educational") engagementMult *= 1.15;
  if (contentType === "story") engagementMult *= 1.05;
  if (mediaType === "video") engagementMult *= 1.1;
  engagementMult *= 0.8 + Math.random() * 0.5;

  const impressions = randomBetween(baseline.impressionsMin, baseline.impressionsMax);
  const reach = Math.round(impressions * (0.6 + Math.random() * 0.35));
  const engagementRate = Math.max(0.1, baseline.engagementRateBase * engagementMult * (0.8 + Math.random() * 0.4));
  const totalEngagements = Math.round((impressions * engagementRate) / 100);

  const likes = Math.round(totalEngagements * (0.45 + Math.random() * 0.2));
  const comments = Math.round(totalEngagements * (0.1 + Math.random() * 0.1));
  const shares = Math.round(totalEngagements * (0.05 + Math.random() * 0.1));
  const saves = Math.round(totalEngagements * (0.05 + Math.random() * 0.08));
  const clicks = Math.round(totalEngagements * (0.1 + Math.random() * 0.15));
  const engagement = likes + comments + shares + saves;

  return {
    impressions, reach, engagement, clicks, saves, shares, comments, likes,
    engagementRate: Math.round(engagementRate * 1000) / 1000,
  };
}

// ── Main seed function ───────────────────────────────────────────────────────

async function seedAutopilot() {
  console.log("🤖 Seeding autopilot data for Michelle Weadbrock...\n");

  const client = await prisma.client.findUnique({ where: { id: CLIENT_ID } });
  if (!client) {
    console.error(`❌ Client ${CLIENT_ID} not found.`);
    process.exit(1);
  }
  console.log(`✅ Found client: ${client.name} (${CLIENT_ID})`);

  // ── Clean existing autopilot drafts ──────────────────────────────────────
  console.log("\n🧹 Cleaning existing autopilot seed data...");
  const deletedDrafts = await prisma.draft.deleteMany({
    where: {
      clientId: CLIENT_ID,
      createdBy: "system:autopilot",
      warnings: { hasSome: ["autopilot: true"] },
    },
  });
  console.log(`   Deleted ${deletedDrafts.count} existing autopilot drafts`);

  // ── Create autopilot drafts ──────────────────────────────────────────────
  console.log("\n📝 Creating autopilot drafts...");

  const shuffledStatuses = [...STATUS_DISTRIBUTION].sort(() => Math.random() - 0.5);

  for (let i = 0; i < TOTAL_AUTOPILOT_DRAFTS; i++) {
    const template = pick(AUTOPILOT_TEMPLATES);
    const status = shuffledStatuses[i % shuffledStatuses.length];
    const channel = pick(CHANNELS);
    const bodyIndex = Math.floor(Math.random() * template.bodies.length);
    const body = template.bodies[bodyIndex];
    const hooks = template.hooks[Math.min(bodyIndex, template.hooks.length - 1)];
    const hashtags = template.hashtags[Math.min(bodyIndex, template.hashtags.length - 1)];
    const mediaType = pick(MEDIA_TYPE_WEIGHTS[channel]);
    const daysAgoVal = randomBetween(1, 75);

    const createdAt = daysAgo(daysAgoVal);
    createdAt.setHours(randomBetween(6, 10), randomBetween(0, 59), 0, 0);

    const publishedAt = status === "PUBLISHED" ? new Date(createdAt.getTime() + randomBetween(1, 48) * 3600000) : null;

    // Build autopilot warnings metadata
    const warnings = [
      "autopilot: true",
      `autopilot_trigger: ${template.trigger}`,
      `autopilot_reason: ${template.reason}`,
      `autopilot_channel: ${channel}`,
      "autopilot_mode: draft_assist",
      `autopilot_angle: ${template.angleKey}`,
      `autopilot_angle_label: ${template.angle}`,
    ];

    const scheduledFor = status === "SCHEDULED"
      ? new Date(Date.now() + randomBetween(12, 72) * 3600000)
      : null;

    const draft = await prisma.draft.create({
      data: {
        clientId: CLIENT_ID,
        kind: mediaType === "video" ? "VIDEO_SCRIPT" : "POST",
        status,
        channel,
        bucketKey: pick(["listings", "market-updates", "tips", "neighborhood"]),
        generationGuidance: `Autopilot: ${template.reason}`,
        body,
        hooks,
        hashtags,
        mediaType,
        mediaUrl: mediaType === "text" ? null : `https://placeholder.test/seed/autopilot_${i}.jpg`,
        externalPostId: status === "PUBLISHED" ? fakeExternalId(channel, i) : null,
        publishedAt,
        publishSource: status === "PUBLISHED" ? "api" : null,
        createdBy: "system:autopilot",
        approvedBy: status === "PUBLISHED" || status === "APPROVED" || status === "SCHEDULED" ? "user" : null,
        approvedAt: status === "PUBLISHED" || status === "APPROVED" || status === "SCHEDULED"
          ? new Date(createdAt.getTime() + randomBetween(1, 24) * 3600000)
          : null,
        scheduledFor,
        rejectedReason: status === "REJECTED" ? pick(["Tone doesn't match brand voice", "Already covered this topic recently"]) : null,
        warnings,
        createdAt,
      },
    });

    // Create metrics + insights for PUBLISHED drafts
    if (status === "PUBLISHED" && publishedAt) {
      const metrics = generateMetrics(channel, template.contentType, mediaType);
      const qualityScore = randomBetween(45, 85);
      const observedScore = randomBetween(35, 90);
      const compositeScore = Math.round((qualityScore * 0.4 + observedScore * 0.6));

      // NormalizedMetric
      await prisma.normalizedMetric.create({
        data: {
          clientId: CLIENT_ID,
          draftId: draft.id,
          channel,
          impressions: metrics.impressions,
          reach: metrics.reach,
          engagements: metrics.engagement,
          clicks: metrics.clicks,
          engagementRate: metrics.engagementRate,
          relativeEngagementRate: Math.round((metrics.engagementRate / PLATFORM_BASELINES[channel].engagementRateBase) * 1000) / 1000,
        },
      });

      // PostMetrics
      await prisma.postMetrics.create({
        data: {
          draftId: draft.id,
          clientId: CLIENT_ID,
          channel,
          ...metrics,
          lastSyncedAt: new Date(),
        },
      });

      // PostInsight
      const bodyLen = body.length;
      const lengthBucket = bodyLen < 100 ? "short" : bodyLen > 500 ? "long" : "medium";
      const firstLine = (body.split("\n")[0] || "").toLowerCase();
      let hookType = "statement";
      if (firstLine.includes("?")) hookType = "question";
      else if (firstLine.includes("just listed") || firstLine.includes("just sold")) hookType = "direct_offer";
      else if (/^\d+\s/.test(firstLine)) hookType = "list";

      await prisma.postInsight.create({
        data: {
          clientId: CLIENT_ID,
          draftId: draft.id,
          qualityScore,
          observedScore,
          compositeScore,
          contentType: template.contentType,
          hookType,
          sentiment: "positive",
          lengthBucket,
          mediaType,
          postingTimeBucket: "morning",
          recommendationTags: [],
        },
      });
    }

    const statusIcon = {
      PUBLISHED: "✅",
      APPROVED: "👍",
      PENDING_REVIEW: "⏳",
      DRAFT: "📝",
      REJECTED: "❌",
      SCHEDULED: "📅",
    };
    console.log(`   ${statusIcon[status] || "•"} ${status.padEnd(15)} ${channel.padEnd(12)} ${template.trigger.padEnd(18)} ${body.slice(0, 50).replace(/\n/g, " ")}...`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const counts = {};
  for (const s of STATUS_DISTRIBUTION) counts[s] = (counts[s] || 0);
  // Recount from what was actually created
  const created = await prisma.draft.findMany({
    where: { clientId: CLIENT_ID, createdBy: "system:autopilot" },
    select: { status: true },
  });
  const statusCounts = {};
  for (const d of created) statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;

  console.log(`\n📊 Autopilot seed complete!`);
  console.log(`   Total drafts: ${created.length}`);
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`   ${status}: ${count}`);
  }

  await prisma.$disconnect();
}

seedAutopilot().catch((err) => {
  console.error("❌ Seed failed:", err);
  prisma.$disconnect();
  process.exit(1);
});
