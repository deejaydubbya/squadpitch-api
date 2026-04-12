// Seed business data for Prestige Properties Group
import { prisma } from "../prisma.js";

async function main() {
  const client = await prisma.client.findFirst({
    where: { name: { contains: "Prestige" } },
    select: { id: true, name: true },
  });

  if (!client) {
    console.log("Client 'Prestige Properties' not found");
    process.exit(1);
  }

  console.log(`Found client: ${client.name} (${client.id})`);

  // Get or create default data source
  let ds = await prisma.workspaceDataSource.findFirst({
    where: { clientId: client.id },
  });
  if (!ds) {
    ds = await prisma.workspaceDataSource.create({
      data: { clientId: client.id, type: "MANUAL", name: "Manual Entry" },
    });
    console.log("Created default data source");
  }

  const items = [
    // TESTIMONIAL
    {
      type: "TESTIMONIAL",
      title: "The Hendersons — Dream Home Found in 2 Weeks",
      summary:
        "First-time buyers who found their forever home in Riverside Estates within 14 days of listing, $15K under asking.",
      dataJson: {
        clientName: "Mark & Sarah Henderson",
        quote:
          "We never thought buying our first home would be this smooth. The Prestige team guided us every step of the way.",
        rating: 5,
        propertyType: "Single-family home",
        neighborhood: "Riverside Estates",
        closingTime: "14 days",
      },
      priority: 8,
    },
    {
      type: "TESTIMONIAL",
      title: "Luxury Condo Sold 20% Above Asking",
      summary:
        "Seller testimonial — downtown penthouse listed at $1.2M, sold for $1.44M after a bidding war.",
      dataJson: {
        clientName: "Diana Reyes",
        quote:
          "I was blown away. They staged the condo beautifully, and we had 6 offers in the first weekend.",
        rating: 5,
        propertyType: "Penthouse condo",
        salePrice: "$1,440,000",
        aboveAsking: "20%",
      },
      priority: 9,
    },
    // CASE_STUDY
    {
      type: "CASE_STUDY",
      title: "Turning a Fixer-Upper Into a $800K Sale",
      summary:
        "How we helped a client renovate and sell a neglected 1970s ranch for 3x their purchase price.",
      dataJson: {
        challenge: "Client purchased a dated 1970s ranch home for $275K with significant deferred maintenance.",
        solution: "Coordinated $45K in targeted renovations: kitchen, bathrooms, curb appeal. Professional staging and drone photography.",
        result: "Sold for $800K in 21 days — 2.9x return on investment.",
        timeline: "4 months renovation + 21 days on market",
      },
      priority: 7,
    },
    {
      type: "CASE_STUDY",
      title: "Relocating a Family of 5 in 30 Days",
      summary:
        "Coordinated simultaneous sell and buy across two states for a corporate relocation.",
      dataJson: {
        challenge: "Family needed to sell in Austin and buy in Denver within 30 days due to job transfer.",
        solution: "Dual-agent coordination, bridge financing, virtual tours for Denver properties while in Austin.",
        result: "Sold Austin home at full asking, closed on Denver home 3 days later. Zero gap in housing.",
        timeline: "28 days total",
      },
      priority: 6,
    },
    // STATISTIC
    {
      type: "STATISTIC",
      title: "98.2% Asking Price Achievement Rate",
      summary: "Our listings sell at 98.2% of asking price on average — 4.7% above market average.",
      dataJson: {
        metric: "Asking price achievement",
        value: "98.2%",
        comparison: "Market average: 93.5%",
        period: "Last 12 months",
        sampleSize: "142 transactions",
      },
      priority: 9,
    },
    {
      type: "STATISTIC",
      title: "Average Days on Market: 18",
      summary: "Our listings sell in 18 days on average vs. 34 days market average.",
      dataJson: {
        metric: "Average days on market",
        value: "18 days",
        comparison: "Market average: 34 days",
        period: "Last 12 months",
        improvement: "47% faster",
      },
      priority: 8,
    },
    // PRODUCT_LAUNCH
    {
      type: "PRODUCT_LAUNCH",
      title: "New Listing: 4BR Craftsman in Oakwood Heights",
      summary: "Just listed — stunning 4-bedroom Craftsman with original details and modern updates. $625,000.",
      dataJson: {
        address: "742 Oakwood Drive, Oakwood Heights",
        price: "$625,000",
        bedrooms: 4,
        bathrooms: 3,
        sqft: 2800,
        highlights: ["Original hardwood floors", "Chef's kitchen with marble counters", "Private backyard with mature oaks", "Walking distance to downtown"],
        openHouseDate: "This Saturday 1-4 PM",
      },
      priority: 10,
    },
    {
      type: "PRODUCT_LAUNCH",
      title: "Coming Soon: The Meridian at Lakeview",
      summary: "Exclusive pre-sale access to 24 luxury townhomes starting at $475K. Modern design, lake views.",
      dataJson: {
        development: "The Meridian at Lakeview",
        units: 24,
        priceFrom: "$475,000",
        priceTo: "$725,000",
        completion: "Q3 2026",
        highlights: ["Private rooftop decks", "Smart home included", "2-car garages", "Lake trail access"],
      },
      priority: 10,
    },
    // PROMOTION
    {
      type: "PROMOTION",
      title: "Free Home Valuation — Spring Market Special",
      summary: "Complimentary professional home valuation with no obligation. Limited to first 50 requests.",
      dataJson: {
        offer: "Free professional home valuation",
        value: "$500 value",
        deadline: "May 31, 2026",
        limit: "First 50 requests",
        cta: "Book your free valuation today",
        url: "https://prestigeproperties.com/valuation",
      },
      priority: 7,
      expiresAt: "2026-05-31T23:59:59Z",
    },
    // MILESTONE
    {
      type: "MILESTONE",
      title: "$100M in Total Sales Volume",
      summary: "Prestige Properties has surpassed $100 million in total sales volume since founding.",
      dataJson: {
        achievement: "$100M total sales volume",
        date: "March 2026",
        context: "Reached this milestone in just 4 years of operation.",
        totalTransactions: 312,
      },
      priority: 8,
    },
    {
      type: "MILESTONE",
      title: "Ranked #3 Brokerage in Metro Area",
      summary: "Recognized as the 3rd highest-producing brokerage by the Metro Board of Realtors.",
      dataJson: {
        achievement: "#3 ranked brokerage",
        awardBody: "Metro Board of Realtors",
        year: 2025,
        category: "Total sales volume",
      },
      priority: 7,
    },
    // FAQ
    {
      type: "FAQ",
      title: "How long does it take to sell a home?",
      summary: "Common buyer/seller FAQ — our average is 18 days on market.",
      dataJson: {
        question: "How long does it typically take to sell a home?",
        answer: "Our listings average 18 days on market — nearly half the local average of 34 days. Factors include pricing strategy, staging, and marketing reach. We'll give you a realistic timeline during your free consultation.",
      },
      priority: 5,
    },
    {
      type: "FAQ",
      title: "What are closing costs and who pays them?",
      summary: "Breakdown of typical closing costs for buyers and sellers in our market.",
      dataJson: {
        question: "What are closing costs and who pays them?",
        answer: "Closing costs typically run 2-5% of the purchase price. Buyers usually cover loan origination, appraisal, and title insurance. Sellers typically pay agent commissions and transfer taxes. We negotiate to minimize your costs wherever possible.",
      },
      priority: 4,
    },
    // TEAM_SPOTLIGHT
    {
      type: "TEAM_SPOTLIGHT",
      title: "Meet Agent of the Year: Jessica Park",
      summary: "Jessica closed 47 transactions in 2025, earning our internal Agent of the Year award.",
      dataJson: {
        name: "Jessica Park",
        role: "Senior Agent",
        achievement: "47 transactions closed in 2025",
        specialties: ["Luxury homes", "First-time buyers", "Investment properties"],
        quote: "Every client deserves the same white-glove experience, whether it's a $200K starter or a $2M estate.",
        yearsExperience: 8,
      },
      priority: 6,
    },
    // EVENT
    {
      type: "EVENT",
      title: "Spring Open House Weekend — May 17-18",
      summary: "Tour 8 of our newest listings in one weekend. Refreshments, live music, and exclusive buyer incentives.",
      dataJson: {
        eventName: "Spring Open House Weekend",
        dates: "May 17-18, 2026",
        time: "11 AM - 5 PM",
        locations: "8 properties across Oakwood, Lakeview, and Downtown",
        perks: ["Complimentary refreshments", "Live music", "$2,500 closing credit for weekend buyers"],
        rsvpUrl: "https://prestigeproperties.com/spring-open-house",
      },
      priority: 8,
      expiresAt: "2026-05-18T23:59:59Z",
    },
    // INDUSTRY_NEWS
    {
      type: "INDUSTRY_NEWS",
      title: "Mortgage Rates Drop to 5.8% — Best Time to Buy?",
      summary: "National mortgage rates hit 5.8%, the lowest in 18 months. What this means for buyers and sellers.",
      dataJson: {
        headline: "Mortgage Rates Drop to 5.8%",
        source: "Freddie Mac Weekly Survey",
        date: "April 2026",
        keyPoints: [
          "30-year fixed rate at 5.8%, down from 6.9% peak",
          "Buying power increased ~12% for average buyer",
          "Inventory remains tight — expect competition",
        ],
        takeaway: "If you've been waiting on the sidelines, this rate drop could save you $200+/month on a $400K mortgage.",
      },
      priority: 7,
    },
    // CUSTOM
    {
      type: "CUSTOM",
      title: "Neighborhood Guide: Why Oakwood Heights Is Trending",
      summary: "Local market insight — Oakwood Heights home values up 14% YoY with new restaurant row and school upgrades.",
      dataJson: {
        neighborhood: "Oakwood Heights",
        priceGrowth: "14% year-over-year",
        medianPrice: "$585,000",
        highlights: ["New restaurant row on Main St", "Elementary school renovation complete", "12-minute commute to downtown", "Walkability score: 82"],
        bestFor: ["Young families", "Remote workers", "Investors"],
      },
      priority: 6,
    },
  ];

  let created = 0;
  for (const item of items) {
    const expiresAt = item.expiresAt ? new Date(item.expiresAt) : null;
    await prisma.workspaceDataItem.create({
      data: {
        clientId: client.id,
        dataSourceId: ds.id,
        type: item.type,
        title: item.title,
        summary: item.summary,
        dataJson: item.dataJson,
        tags: [],
        priority: item.priority,
        expiresAt,
        status: "ACTIVE",
      },
    });
    created++;
    console.log(`  Created: [${item.type}] ${item.title}`);
  }

  console.log(`\nDone! Created ${created} business data items for ${client.name}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
