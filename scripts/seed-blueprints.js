// Seed 12 content blueprints for the data-aware generation system.
//
// Usage: node scripts/seed-blueprints.js
// Idempotent — uses upsert keyed on slug.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ALL_CHANNELS = [
  "INSTAGRAM",
  "TIKTOK",
  "X",
  "LINKEDIN",
  "FACEBOOK",
  "YOUTUBE",
];

const blueprints = [
  {
    slug: "testimonial-spotlight",
    name: "Testimonial Spotlight",
    description:
      "Turn a customer testimonial into a compelling social proof post that highlights real results.",
    category: "SOCIAL_PROOF",
    applicableTypes: ["TESTIMONIAL"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a social proof post that spotlights a customer testimonial. Lead with the most impactful quote or result. Frame it as a real story, not a sales pitch. Include the customer's name/role if provided. End with a subtle CTA that invites others to share their experience or learn more.",
  },
  {
    slug: "results-breakdown",
    name: "Results Breakdown",
    description:
      "Break down a case study or statistic into a digestible, data-driven post.",
    category: "SOCIAL_PROOF",
    applicableTypes: ["CASE_STUDY", "STATISTIC"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a data-driven post that breaks down a specific result or statistic. Open with the headline number or outcome. Provide brief context on what was done and why it matters. Use the data to tell a story, not just list numbers. Keep it conversational and avoid jargon.",
  },
  {
    slug: "before-after-transformation",
    name: "Before & After Transformation",
    description:
      "Tell a transformation story using a case study or testimonial.",
    category: "STORYTELLING",
    applicableTypes: ["CASE_STUDY", "TESTIMONIAL"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a transformation story post. Structure it as: the problem/before state, what changed (the product or service intervention), and the after state with concrete results. Make the reader feel the contrast. Use specific details from the data provided rather than generic claims.",
  },
  {
    slug: "myth-buster",
    name: "Myth Buster",
    description:
      "Challenge a common misconception using data, stats, or expert knowledge.",
    category: "EDUCATION",
    applicableTypes: ["STATISTIC", "FAQ", "INDUSTRY_NEWS"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a myth-busting post that challenges a common misconception in the industry. Open with the myth stated plainly, then dismantle it with the provided data or facts. Be direct and slightly contrarian — this should stop the scroll. End with the correct takeaway.",
  },
  {
    slug: "did-you-know",
    name: "Did You Know?",
    description:
      "Share a surprising fact, statistic, or milestone in an engaging educational format.",
    category: "EDUCATION",
    applicableTypes: ["STATISTIC", "INDUSTRY_NEWS", "MILESTONE"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write an educational post that opens with a surprising or counterintuitive fact. Frame the data in a way that makes the audience curious. Provide context that explains why this matters to them specifically. Keep the tone conversational and authoritative, not preachy.",
  },
  {
    slug: "launch-announcement",
    name: "Launch Announcement",
    description:
      "Announce a product launch, event, or new offering with excitement and clarity.",
    category: "PROMOTION",
    applicableTypes: ["PRODUCT_LAUNCH", "EVENT", "PROMOTION"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a launch announcement post. Lead with what's new and why the audience should care (benefit-first, not feature-first). Build excitement without being hyperbolic. Include key details (what, when, how to access) and a clear CTA. Sound genuinely enthusiastic, not corporate.",
  },
  {
    slug: "limited-time-offer",
    name: "Limited-Time Offer",
    description:
      "Create urgency around a promotion or time-sensitive event.",
    category: "PROMOTION",
    applicableTypes: ["PROMOTION", "EVENT"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write an urgency-driven promotional post. Lead with the value proposition, not the deadline. Make the offer feel exclusive and worthwhile. Include the specific deadline or limitation. Use scarcity naturally — avoid fake urgency. End with a direct, frictionless CTA.",
  },
  {
    slug: "team-highlight",
    name: "Team Highlight",
    description:
      "Showcase a team member, their role, and what makes them great.",
    category: "BEHIND_THE_SCENES",
    applicableTypes: ["TEAM_SPOTLIGHT"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a team spotlight post that humanizes the brand. Introduce the team member by name and role. Share something specific and genuine about their work, passion, or a fun fact. Make the audience feel like they're meeting a real person. Keep it warm and authentic, not a corporate bio.",
  },
  {
    slug: "milestone-celebration",
    name: "Milestone Celebration",
    description:
      "Celebrate a company milestone and share gratitude with the community.",
    category: "BEHIND_THE_SCENES",
    applicableTypes: ["MILESTONE"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a milestone celebration post. Share the specific achievement with genuine gratitude. Acknowledge the people who made it possible (team, customers, community). Reflect briefly on the journey. Make the audience feel like they're part of the story. Avoid making it sound like bragging.",
  },
  {
    slug: "faq-answer",
    name: "FAQ Answer",
    description:
      "Turn a frequently asked question into valuable educational content.",
    category: "ENGAGEMENT",
    applicableTypes: ["FAQ"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write an FAQ-style post that answers a common question the audience has. State the question clearly upfront. Give a concise, helpful answer that demonstrates expertise. Add a practical tip or insight that goes beyond the obvious answer. Invite the audience to ask more questions.",
  },
  {
    slug: "hot-take",
    name: "Hot Take",
    description:
      "Share a bold, opinionated perspective backed by data or industry knowledge.",
    category: "AUTHORITY",
    applicableTypes: ["INDUSTRY_NEWS", "STATISTIC"],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a bold, opinionated post that takes a clear stance on an industry topic. Open with a provocative or contrarian statement. Back it up with the provided data or reasoning. Be confident but not arrogant. Invite discussion — end with a question or challenge to the audience's assumptions.",
  },
  {
    slug: "seasonal-tie-in",
    name: "Seasonal Tie-In",
    description:
      "Connect business data to a seasonal moment, holiday, or cultural event.",
    category: "SEASONAL",
    applicableTypes: [
      "PROMOTION",
      "PRODUCT_LAUNCH",
      "EVENT",
      "MILESTONE",
      "CUSTOM",
    ],
    applicableChannels: ALL_CHANNELS,
    promptTemplate:
      "Write a post that naturally connects the business data to a seasonal moment, holiday, or cultural event. The tie-in should feel organic, not forced. Lead with the seasonal hook, then weave in the business angle. Keep it timely and relevant. If there's a promotion or offer, present it as a natural fit for the season.",
  },
];

async function main() {
  console.log("Seeding content blueprints...");

  for (const bp of blueprints) {
    await prisma.contentBlueprint.upsert({
      where: { slug: bp.slug },
      update: {
        name: bp.name,
        description: bp.description,
        category: bp.category,
        promptTemplate: bp.promptTemplate,
        applicableTypes: bp.applicableTypes,
        applicableChannels: bp.applicableChannels,
        isActive: true,
      },
      create: bp,
    });
    console.log(`  ✓ ${bp.slug}`);
  }

  console.log(`\nDone — ${blueprints.length} blueprints seeded.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
