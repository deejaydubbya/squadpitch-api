/**
 * Real Estate Canonical Workspace Context
 *
 * This module defines the single source of truth for a real estate workspace's
 * resolved state — what's connected, what capabilities are available, and what
 * data assets exist. All consumers (dashboard, generation, recommendations)
 * read from this one canonical object instead of independently querying
 * tech stack state.
 *
 * ## Manual vs Mapped items
 *
 * - **Manual** items (idx_website, listing_feed) are configured directly by the
 *   user in the tech stack UI. Their connection state lives in the
 *   WorkspaceTechStackConnection table.
 * - **Mapped** items (facebook_page, instagram_business, google_business_profile)
 *   derive their connection state from the ChannelConnection table via
 *   `channelRef`. The tech stack does NOT own their integration mechanics —
 *   it only reflects whether the channel platform is connected.
 *
 * ## Adding future real estate items
 *
 * 1. Add the provider to `real_estate.js` techStack array
 * 2. Add an entry to RE_CAPABILITY_MAP below
 * 3. Add a slot to the techStack shape in resolveRealEstateContext()
 * 4. The resolver will automatically pick up connection state from
 *    getWorkspaceTechStackView()
 */

import { prisma } from "../../prisma.js";
import { getWorkspaceTechStackView } from "./techStack.service.js";

// ── Capability map ──────────────────────────────────────────────────────

/**
 * Defines what each real estate tech stack item contributes to the workspace.
 * This is the architectural contract — it tells consumers what data and UX
 * each connected item unlocks.
 */
export const RE_CAPABILITY_MAP = {
  idx_website: {
    type: "manual",
    ownedBy: "tech_stack",
    capabilities: ["website_context", "business_identity", "brand_enrichment"],
    contributes: {
      data: ["website_content", "business_context"],
      ux: "Enriches generation with business context, brand voice, and website content",
    },
    usedFor: "Enriches AI-generated content with real website pages, services, and business details",
  },
  facebook_page: {
    type: "mapped",
    ownedBy: "channel_platform",
    channelRef: "FACEBOOK",
    capabilities: ["publish_facebook", "social_presence"],
    contributes: {
      data: [],
      ux: "Publish and schedule to Facebook",
    },
    usedFor: "Publish listing promotions, market updates, and community content to Facebook",
  },
  instagram_business: {
    type: "mapped",
    ownedBy: "channel_platform",
    channelRef: "INSTAGRAM",
    capabilities: ["publish_instagram", "visual_social_presence"],
    contributes: {
      data: [],
      ux: "Publish visual content to Instagram",
    },
    usedFor: "Share property photos, virtual tours, and brand content on Instagram",
  },
  listing_feed: {
    type: "manual",
    ownedBy: "tech_stack",
    capabilities: ["listing_data", "property_marketing", "listing_based_recommendations"],
    contributes: {
      data: ["listings"],
      ux: "Powers listing posts, open house alerts, price drops",
    },
    usedFor: "Powers just-listed posts, open house alerts, price drop announcements, and property marketing",
  },
  google_business_profile: {
    type: "mapped",
    ownedBy: "channel_platform",
    channelRef: "GOOGLE",
    capabilities: ["local_presence", "review_data", "trust_content", "publish_google_posts"],
    contributes: {
      data: ["reviews"],
      ux: "Review-based content, local SEO, Google posts",
    },
    usedFor: "Strengthen local search presence, manage reviews, and publish Google posts",
  },
  property_api: {
    type: "manual",
    ownedBy: "tech_stack",
    capabilities: ["property_enrichment", "data_enrichment", "listing_details"],
    contributes: {
      data: ["property_details", "valuations", "tax_data"],
      ux: "Auto-enriches listings with bedrooms, bathrooms, sqft, valuations, and more",
    },
    usedFor: "Automatically enrich property listings with details, valuations, and tax data from ATTOM, Estated, or RentCast",
  },
  real_estate_crm: {
    type: "manual",
    ownedBy: "tech_stack",
    capabilities: ["crm_data", "milestone_signals", "testimonial_signals", "content_source"],
    contributes: {
      data: ["milestones", "testimonials", "content_signals"],
      ux: "Powers 'Just Sold' posts, client testimonials, and milestone celebrations",
    },
    usedFor: "Import closed deals, client milestones, and testimonial signals from your CRM",
  },
};

// ── Resolver ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RealEstateWorkspaceContext
 * @property {"real_estate"} industry
 * @property {string} workspaceId
 * @property {{ businessName: string | null, marketArea: string | null, city: string | null, state: string | null, websiteUrl: string | null, extraContext: string | null }} businessProfile
 * @property {Object} techStack
 * @property {{ listingsAvailable: boolean, listingCount: number, reviewsAvailable: boolean, reviewCount: number }} assets
 * @property {{ availableChannels: string[] }} publishing
 * @property {string[]} capabilities
 */

/**
 * Resolve the canonical real estate workspace context.
 *
 * Combines tech stack connection state, brand profile, data item counts,
 * and channel connections into a single normalized object.
 *
 * @param {string} workspaceId
 * @returns {Promise<RealEstateWorkspaceContext>}
 */
export async function resolveRealEstateContext(workspaceId) {
  // 1. Get merged tech stack view (reuses existing logic — no duplication)
  const [techStackView, client, dataItemCounts, channelConnections] = await Promise.all([
    getWorkspaceTechStackView(workspaceId),
    prisma.client.findUnique({
      where: { id: workspaceId },
      include: { brandProfile: true },
    }),
    prisma.workspaceDataItem.groupBy({
      by: ["type"],
      where: { clientId: workspaceId, status: "ACTIVE" },
      _count: { _all: true },
    }),
    prisma.channelConnection.findMany({
      where: { clientId: workspaceId, status: "CONNECTED" },
      select: { channel: true, id: true },
    }),
  ]);

  // 2. Build a providerKey → view item map for quick lookup
  const viewMap = Object.fromEntries(techStackView.map((i) => [i.providerKey, i]));

  // 3. Build data counts map
  // Source of truth: WorkspaceDataItems (see realEstateAssets.js for data ownership docs)
  // Listings = CUSTOM type, Reviews = TESTIMONIAL type
  const dataCounts = Object.fromEntries(
    dataItemCounts.map((r) => [r.type, r._count._all]),
  );
  const listingCount = dataCounts.CUSTOM ?? 0;
  const reviewCount = dataCounts.TESTIMONIAL ?? 0;

  // 4. Build channel connection ID map
  const channelIdMap = Object.fromEntries(
    channelConnections.map((c) => [c.channel, c.id]),
  );

  // 5. Helper to resolve a single tech stack slot
  const resolveSlot = (providerKey) => {
    const view = viewMap[providerKey];
    const capMap = RE_CAPABILITY_MAP[providerKey];
    if (!view || !capMap) return null;

    const isConnected = view.connectionStatus === "connected";

    const base = {
      status: view.connectionStatus,
      capabilities: capMap.capabilities,
      usedFor: capMap.usedFor ?? null,
    };

    if (capMap.type === "manual") {
      return {
        ...base,
        isManual: true,
        url: view.metadataJson?.url ?? null,
        lastSyncedAt: view.metadataJson?.lastSyncedAt ?? null,
      };
    }

    // Mapped (channel-derived)
    const statusDetail = isConnected
      ? `Connected via ${capMap.channelRef}`
      : view.status === "planned"
        ? `Coming soon — ${view.label} integration is planned`
        : `Connect your ${view.label} to enable publishing`;

    return {
      ...base,
      isMapped: true,
      channelConnectionId: channelIdMap[capMap.channelRef] ?? null,
      statusDetail,
    };
  };

  // 6. Flatten unique capabilities from all connected items
  const allCapabilities = new Set();
  for (const [providerKey, capMap] of Object.entries(RE_CAPABILITY_MAP)) {
    const view = viewMap[providerKey];
    if (view?.connectionStatus === "connected") {
      for (const cap of capMap.capabilities) allCapabilities.add(cap);
    }
  }

  // 7. Available publishing channels
  const availableChannels = channelConnections.map((c) => c.channel);

  // 8. Business profile from brand
  const brand = client?.brandProfile;

  return {
    industry: "real_estate",
    workspaceId,
    businessProfile: {
      businessName: brand?.businessName ?? client?.name ?? null,
      marketArea: brand?.marketArea ?? null,
      city: brand?.city ?? null,
      state: brand?.state ?? null,
      websiteUrl: brand?.website ?? null,
      extraContext: brand?.extraContext ?? null,
    },
    techStack: {
      website: (() => {
        const slot = resolveSlot("idx_website");
        if (!slot) return null;
        const url = slot.url;
        slot.statusDetail = slot.status === "connected"
          ? `Connected — ${url}`
          : "Add your website URL to enrich content generation";
        slot.summary = slot.status === "connected" && url ? url : null;
        return slot;
      })(),
      facebookPage: resolveSlot("facebook_page"),
      instagramBusiness: resolveSlot("instagram_business"),
      listingFeed: (() => {
        const slot = resolveSlot("listing_feed");
        if (!slot) return null;
        const sourceUrl = viewMap.listing_feed?.metadataJson?.sourceUrl ?? null;
        const lastSyncedAt = viewMap.listing_feed?.metadataJson?.lastSyncedAt ?? null;
        let hostname = null;
        if (sourceUrl) {
          try { hostname = new URL(sourceUrl).hostname; } catch {}
        }
        let statusDetail;
        if (slot.status === "connected" && listingCount > 0) {
          statusDetail = `Connected — ${listingCount} listing${listingCount === 1 ? "" : "s"} from ${hostname}`;
        } else if (slot.status === "connected") {
          statusDetail = "Connected — no listings extracted yet. Refresh to import.";
        } else {
          statusDetail = "Add your listings page URL to power listing content";
        }
        return {
          ...slot,
          sourceUrl,
          listingCount,
          lastSyncedAt,
          statusDetail,
          summary: slot.status === "connected" && listingCount > 0
            ? `${listingCount} active listing${listingCount === 1 ? "" : "s"} from ${hostname}`
            : null,
        };
      })(),
      googleBusinessProfile: (() => {
        const slot = resolveSlot("google_business_profile");
        if (!slot) return null;
        return {
          ...slot,
          reviewCount,
          averageRating: viewMap.google_business_profile?.metadataJson?.averageRating ?? null,
          locationId: viewMap.google_business_profile?.metadataJson?.locationId ?? null,
        };
      })(),
    },
    assets: {
      listingsAvailable: listingCount > 0,
      listingCount,
      reviewsAvailable: reviewCount > 0,
      reviewCount,
    },
    publishing: {
      availableChannels,
    },
    capabilities: [...allCapabilities],
  };
}
