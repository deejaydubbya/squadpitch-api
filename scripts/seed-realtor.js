import { prisma } from "../prisma.js";

async function seed() {
  console.log("Seeding realtor client...");

  const client = await prisma.client.create({
    data: {
      name: "Prestige Properties Group",
      slug: "prestige-properties",
      status: "ACTIVE",
      createdBy: "seed",

      brandProfile: {
        create: {
          description:
            "Prestige Properties Group is a boutique real estate brokerage specializing in luxury residential properties in the greater Austin, TX area. Founded in 2019, we combine white-glove service with cutting-edge marketing to help clients buy and sell homes with confidence.",
          industry: "Real Estate",
          audience:
            "First-time homebuyers aged 28-40, move-up buyers aged 35-55, luxury home sellers, relocating professionals, and real estate investors in the Austin metro area.",
          website: "https://www.prestigepropertiesatx.com",
          offers:
            "Free home valuations, buyer consultations, luxury listing packages with professional staging and photography, relocation assistance, investment property analysis, and off-market pocket listings.",
          competitors:
            "Compass Austin, Redfin, Keller Williams Realty, Sotheby's International Realty Austin, Kuper Sotheby's",
          socialsJson: {
            instagram: "@prestigepropsatx",
            facebook: "PrestigePropertiesATX",
            linkedin: "prestige-properties-group",
            tiktok: "@prestigepropsatx",
            youtube: "PrestigePropertiesATX",
          },
          examplePosts: [
            "Just listed! This stunning 4BR/3BA in Westlake Hills features floor-to-ceiling windows, a chef's kitchen, and resort-style backyard. DM for details. 🏡",
            "Austin market update: Median home price hit $525K in March — up 3.2% YoY. Inventory is still tight but improving. Here's what that means for buyers and sellers 👇",
            "Closed another one! Congratulations to the Martinez family on their beautiful new home in Circle C Ranch. From first showing to keys in hand in just 21 days. 🔑🎉",
          ],
          updatedBy: "seed",
        },
      },

      voiceProfile: {
        create: {
          tone: "Professional and knowledgeable with a warm, approachable edge. Confident but never pushy. Light humor occasionally — never forced.",
          voiceRulesJson: {
            doRules: [
              "Lead with value — market insights, tips, neighborhood highlights",
              "Use specific numbers and data points (price, sqft, days on market)",
              "Share genuine success stories and client wins",
              "Be direct about market conditions — honesty builds trust",
              "Include calls to action that feel helpful, not salesy",
            ],
            dontRules: [
              "Never use 'dream home' — it's overused and vague",
              "Avoid all-caps or excessive exclamation marks",
              "Don't bash competitors or other agents",
              "Never share client financial details or private information",
              "Avoid generic motivational quotes unrelated to real estate",
            ],
          },
          bannedPhrases: [
            "dream home",
            "JUST LISTED!!!",
            "won't last long",
            "price reduced",
            "motivated seller",
            "a]must see",
            "cozy",
            "charming fixer-upper",
          ],
          ctaPreferences: {
            preferred: [
              "DM for details",
              "Link in bio for the full listing",
              "Book a free consultation — link in bio",
              "Comment DETAILS and I'll send you the listing",
              "Save this for later 📌",
            ],
            avoid: [
              "Call now!",
              "Don't miss out!",
              "Act fast!",
            ],
          },
          contentBuckets: [
            {
              key: "listings",
              label: "Property Listings",
              weight: 30,
              template: "Showcase a specific property with key features, price point, and neighborhood context.",
            },
            {
              key: "market-updates",
              label: "Market Updates",
              weight: 20,
              template: "Share a recent Austin real estate stat or trend with analysis and what it means for buyers/sellers.",
            },
            {
              key: "tips",
              label: "Buyer & Seller Tips",
              weight: 20,
              template: "Actionable advice for homebuyers or sellers — staging, offers, financing, inspections, etc.",
            },
            {
              key: "neighborhood",
              label: "Neighborhood Spotlights",
              weight: 15,
              template: "Highlight an Austin neighborhood — walkability, schools, dining, lifestyle, price range.",
            },
            {
              key: "behind-the-scenes",
              label: "Behind the Scenes",
              weight: 15,
              template: "Show the day-to-day of being a realtor — showings, closings, staging prep, client wins.",
            },
          ],
          updatedBy: "seed",
        },
      },

      mediaProfile: {
        create: {
          mode: "BRAND_ASSETS_PLUS_AI",
          visualStyle:
            "Clean, modern, and aspirational. Bright natural light, neutral tones with pops of green and gold. Architectural photography style — wide angles, straight verticals. Text overlays use Montserrat Bold in white or dark charcoal on semi-transparent backgrounds.",
          updatedBy: "seed",
        },
      },

      channelSettings: {
        create: [
          {
            channel: "INSTAGRAM",
            isEnabled: true,
            maxChars: 2200,
            allowEmoji: true,
            trailingHashtags: [
              "#AustinRealEstate",
              "#AustinHomes",
              "#ATXRealtor",
              "#LuxuryRealEstate",
              "#AustinTX",
            ],
            notes: "Use carousel format for listings. Reels for market updates and tips.",
          },
          {
            channel: "FACEBOOK",
            isEnabled: true,
            maxChars: 5000,
            allowEmoji: true,
            trailingHashtags: [],
            notes: "Longer-form posts work well here. Include neighborhood context and personal anecdotes.",
          },
          {
            channel: "LINKEDIN",
            isEnabled: true,
            maxChars: 3000,
            allowEmoji: false,
            trailingHashtags: [
              "#RealEstate",
              "#AustinTexas",
              "#HousingMarket",
            ],
            notes: "Professional tone. Focus on market analysis, industry insights, and career milestones.",
          },
          {
            channel: "TIKTOK",
            isEnabled: true,
            maxChars: 2200,
            allowEmoji: true,
            trailingHashtags: [
              "#austinrealestate",
              "#realtortok",
              "#homebuying",
              "#luxuryhomes",
            ],
            notes: "Short, punchy hooks. Use trending sounds when relevant. Speak directly to camera.",
          },
          {
            channel: "YOUTUBE",
            isEnabled: true,
            maxChars: 5000,
            allowEmoji: true,
            trailingHashtags: [],
            notes: "Longer-form neighborhood tours and market update videos. SEO-focused titles and descriptions.",
          },
        ],
      },

      drafts: {
        create: [
          {
            kind: "POST",
            channel: "INSTAGRAM",
            status: "APPROVED",
            generationGuidance: "Write an Austin housing market update post about rising inventory levels. Include specific stats and what it means for buyers, sellers, and investors.",
            body: "Austin housing inventory just crossed 4.2 months of supply — the highest we've seen since 2019.\n\nWhat does that mean for you?\n\n🏠 Buyers: More options, more negotiating power. You're not competing against 15 offers anymore.\n\n💰 Sellers: Pricing right from day one is critical. Overpriced homes are sitting 40+ days.\n\n📊 Investors: Cap rates in East Austin are improving. Worth a second look.\n\nThe market isn't crashing — it's normalizing. And that's actually healthy.\n\nDM me if you want a personalized market analysis for your neighborhood.",
            hooks: [
              "Austin housing inventory just hit a 5-year high 📈",
              "The Austin market just shifted — here's what you need to know",
            ],
            hashtags: [
              "#AustinRealEstate",
              "#AustinHomes",
              "#ATXRealtor",
              "#HousingMarket2025",
            ],
            cta: "DM me if you want a personalized market analysis for your neighborhood.",
            bucketKey: "market-updates",
            createdBy: "seed",
            modelUsed: "gpt-4o-mini",
          },
          {
            kind: "POST",
            channel: "INSTAGRAM",
            status: "DRAFT",
            generationGuidance: "Write a neighborhood spotlight post about Mueller in Austin. Cover walkability, schools, dining, price range, and lifestyle appeal.",
            body: "📍 Neighborhood Spotlight: Mueller\n\nThis former airport turned master-planned community is one of Austin's best-kept secrets for young professionals and families.\n\n✅ Walkability score: 82\n✅ Top-rated elementary schools\n✅ Thinkery children's museum + farmers market\n✅ 10 min to downtown\n✅ Median price: $485K (condos from $320K)\n\nMueller has that rare combo of new construction quality with established neighborhood charm. Plus, the Aldrich Street retail district has some of the best local restaurants in town.\n\nThinking about Mueller? I've helped 12 families find homes here. Let's chat.",
            hooks: [
              "The Austin neighborhood you're sleeping on 👀",
              "Mueller might be Austin's most underrated neighborhood",
            ],
            hashtags: [
              "#MuellerAustin",
              "#AustinNeighborhoods",
              "#AustinRealEstate",
            ],
            cta: "Comment MUELLER and I'll send you current listings.",
            bucketKey: "neighborhood",
            createdBy: "seed",
            modelUsed: "gpt-4o-mini",
          },
          {
            kind: "VIDEO_SCRIPT",
            channel: "TIKTOK",
            status: "PENDING_REVIEW",
            generationGuidance: "Write a TikTok video script for a $475K South Austin home with an ADU that generates rental income. Hook viewers with the house-hacking angle.",
            body: "[HOOK - on camera, walking through front door]\n\"This $475K home in South Austin has something I've never seen before.\"\n\n[REVEAL - pan to open floor plan]\n\"Open concept living with 12-foot ceilings and polished concrete floors.\"\n\n[KITCHEN]\n\"Full chef's kitchen — quartz counters, gas range, custom cabinetry.\"\n\n[BACKYARD]\n\"But here's the kicker — a fully permitted ADU in the backyard that's already rented for $1,400/month.\"\n\n[BACK TO CAMERA]\n\"So your effective mortgage? About $1,800. In Austin. In 2025.\"\n\n[CTA]\n\"Follow for more Austin homes that actually make financial sense. Link in bio for the full listing.\"",
            hooks: [
              "This $475K Austin home pays for itself 🤯",
              "POV: You find a house with a money-printing backyard",
            ],
            hashtags: [
              "#austinrealestate",
              "#realtortok",
              "#househacking",
              "#adu",
            ],
            cta: "Follow for more Austin homes that actually make financial sense.",
            bucketKey: "listings",
            createdBy: "seed",
            modelUsed: "gpt-4o-mini",
          },
          {
            kind: "CAPTION",
            channel: "LINKEDIN",
            status: "PUBLISHED",
            generationGuidance: "Write a LinkedIn post reflecting on 2024 real estate performance. Share 3 key strategies that drove success. Professional tone, invite discussion.",
            body: "Closed 47 transactions in 2024. Here are the 3 things that made the biggest difference:\n\n1. Video-first marketing. Every listing gets a professional walkthrough video, not just photos. Our listings with video sell 23% faster.\n\n2. Radical transparency on pricing. I show sellers real comps, not inflated numbers to win the listing. It means fewer price reductions and faster closes.\n\n3. Investor relationships. I've built a network of 200+ pre-qualified investors who can close in 14 days. When a traditional buyer falls through, I have backup offers ready.\n\nThe market rewards agents who adapt. 2025 is going to reward agents who provide real value over vanity metrics.\n\nWhat's working in your market? I'd love to hear from other agents and brokers.",
            hashtags: [
              "#RealEstate",
              "#RealEstateAgent",
              "#AustinTexas",
            ],
            cta: "What's working in your market?",
            bucketKey: "behind-the-scenes",
            publishedAt: new Date("2025-03-15T14:00:00Z"),
            createdBy: "seed",
            modelUsed: "gpt-4o-mini",
          },
          {
            kind: "CAROUSEL",
            channel: "INSTAGRAM",
            status: "DRAFT",
            generationGuidance: "Write a carousel post covering 5 common first-time homebuyer mistakes with actionable advice on each slide. End with a CTA for a free checklist.",
            body: "Slide 1: 5 First-Time Buyer Mistakes That Cost You Thousands\n\nSlide 2: ❌ Mistake #1 — Not getting pre-approved BEFORE touring homes\nYou'll lose to buyers who already have their letter ready. Get pre-approved first, tour second.\n\nSlide 3: ❌ Mistake #2 — Skipping the inspection to \"win\" the deal\nA $500 inspection can save you from a $30,000 foundation problem. Never skip it.\n\nSlide 4: ❌ Mistake #3 — Only looking at the monthly payment\nFactor in HOA, taxes, insurance, and maintenance. The true cost is 20-30% more than your mortgage.\n\nSlide 5: ❌ Mistake #4 — Falling in love before the appraisal\nIf the home doesn't appraise, you're either paying the difference or walking away. Stay objective.\n\nSlide 6: ❌ Mistake #5 — Not negotiating closing costs\nSellers can contribute 2-6% toward your closing costs. Always ask — the worst they can say is no.\n\nSlide 7: ✅ Want a free first-time buyer checklist? DM me CHECKLIST and I'll send it over.",
            hooks: [
              "5 mistakes costing first-time buyers thousands 💸",
              "I wish someone told me this before buying my first home",
            ],
            hashtags: [
              "#FirstTimeHomeBuyer",
              "#HomeBuyingTips",
              "#AustinRealEstate",
            ],
            cta: "DM me CHECKLIST and I'll send it over.",
            bucketKey: "tips",
            createdBy: "seed",
            modelUsed: "gpt-4o-mini",
          },
        ],
      },
    },
  });

  console.log(`Created client: ${client.name} (${client.id})`);
  console.log("Seed complete!");
}

seed()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
