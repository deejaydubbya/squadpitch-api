// Workspace tech stack connection service.
//
// Reads/writes per-workspace connection state for industry tech stack items.
// Industry config = what tools exist. Workspace state = what the user has connected.

import { prisma } from "../../prisma.js";
import { getIndustryProfile } from "./registry.js";
import { getIndustryTechStack } from "./industry.service.js";
import { getConnection } from "../studio/connection.service.js";
import { RE_CAPABILITY_MAP } from "./realEstateContext.js";

/** @typedef {"not_connected" | "connected" | "pending" | "error"} WorkspaceConnectionStatus */

// ── Read helpers ────────────────────────────────────────────────────

/**
 * Get all tech stack connections for a workspace.
 * @param {string} workspaceId
 */
export async function getWorkspaceTechStackConnections(workspaceId) {
  return prisma.workspaceTechStackConnection.findMany({
    where: { workspaceId },
  });
}

/**
 * Get a providerKey → connectionStatus map for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<Record<string, WorkspaceConnectionStatus>>}
 */
export async function getWorkspaceTechStackConnectionMap(workspaceId) {
  const rows = await getWorkspaceTechStackConnections(workspaceId);
  /** @type {Record<string, WorkspaceConnectionStatus>} */
  const map = {};
  for (const row of rows) {
    map[row.providerKey] = /** @type {WorkspaceConnectionStatus} */ (row.connectionStatus);
  }
  return map;
}

/**
 * Get a providerKey → full connection record map for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<Record<string, { connectionStatus: WorkspaceConnectionStatus, metadataJson: object | null }>>}
 */
async function getWorkspaceTechStackConnectionDetailMap(workspaceId) {
  const rows = await getWorkspaceTechStackConnections(workspaceId);
  /** @type {Record<string, { connectionStatus: WorkspaceConnectionStatus, metadataJson: object | null }>} */
  const map = {};
  for (const row of rows) {
    map[row.providerKey] = {
      connectionStatus: /** @type {WorkspaceConnectionStatus} */ (row.connectionStatus),
      metadataJson: row.metadataJson ?? null,
    };
  }
  return map;
}

// ── Status summary helper (real estate) ─────────────────────────────

/**
 * Build a short human-readable status summary for a real estate tech stack item.
 * @param {string} providerKey
 * @param {string} connectionStatus
 * @param {object | null} metadata
 * @param {object | null} channelState
 * @returns {string | undefined}
 */
function buildRealEstateStatusSummary(providerKey, connectionStatus, metadata, channelState) {
  const connected = connectionStatus === "connected";

  switch (providerKey) {
    case "idx_website":
      if (connected && metadata?.url) return metadata.url;
      return "Add your website to enrich business context";

    case "listing_feed": {
      if (!connected) return "Add listing sources to power your content";
      const count = metadata?.listingCount;
      const sources = metadata?.sourceCount;
      if (count > 0) return `${count} listing${count === 1 ? "" : "s"} from ${sources} source${sources === 1 ? "" : "s"}`;
      return `${sources} source${sources === 1 ? "" : "s"} connected — sync to import`;
    }

    case "facebook_page":
      if (connected) return channelState?.displayName
        ? `${channelState.displayName} — ready for publishing`
        : "Ready for publishing listing posts";
      return "Connect to publish listing posts";

    case "instagram_business":
      if (connected) return channelState?.displayName
        ? `@${channelState.displayName} — ready for publishing`
        : "Ready for publishing property content";
      return "Connect to publish property content";

    case "google_business_profile":
      if (connected) {
        const reviews = metadata?.reviewCount;
        return reviews > 0
          ? `${reviews} review${reviews === 1 ? "" : "s"} available for content`
          : "Connected — reviews power trust content";
      }
      return "Connect to use reviews for content";

    case "property_api": {
      if (!connected) return "Connect a property data API to auto-enrich listings";
      const prov = metadata?.provider;
      return prov
        ? `${prov.charAt(0).toUpperCase() + prov.slice(1)} API connected — enriching listings`
        : "API connected — enriching listings";
    }

    case "real_estate_crm": {
      if (!connected) return "Connect your CRM to import deals and testimonials";
      const deals = metadata?.dealCount;
      const contacts = metadata?.contactCount;
      const parts = [];
      if (deals > 0) parts.push(`${deals} deal${deals === 1 ? "" : "s"}`);
      if (contacts > 0) parts.push(`${contacts} contact${contacts === 1 ? "" : "s"}`);
      if (parts.length > 0) return `${parts.join(", ")} synced`;
      return "Connected — sync to import CRM data";
    }

    default:
      return undefined;
  }
}

// ── Merged view ─────────────────────────────────────────────────────

/**
 * @typedef {Object} WorkspaceTechStackViewItem
 * @property {string} providerKey
 * @property {string} label
 * @property {string} [description]
 * @property {"core" | "recommended" | "optional"} priority
 * @property {"live" | "beta" | "planned"} status
 * @property {string} category
 * @property {string[]} capabilities
 * @property {"oauth" | "manual" | "planned"} connectionMode
 * @property {import("./techStack.types.js").ManualSetupConfig} [manualSetup]
 * @property {string} [channelRef]
 * @property {WorkspaceConnectionStatus} connectionStatus
 * @property {object | null} metadataJson
 * @property {boolean} isPublishing
 * @property {boolean} isImportSource
 * @property {boolean} isWorkflowTool
 */

/**
 * Get a merged tech stack view for a workspace.
 * Combines industry config items with per-workspace connection state.
 *
 * @param {string} workspaceId
 * @returns {Promise<WorkspaceTechStackViewItem[]>}
 */
export async function getWorkspaceTechStackView(workspaceId) {
  // 1. Get workspace's industry key
  const client = await prisma.client.findUnique({
    where: { id: workspaceId },
    select: { industryKey: true },
  });
  if (!client) return [];

  // 2. Get industry tech stack items
  const items = getIndustryTechStack(client.industryKey);
  if (items.length === 0) return [];

  // 3. Get workspace tech stack connections (with metadata)
  const connectionDetailMap = await getWorkspaceTechStackConnectionDetailMap(workspaceId);

  // 4. Resolve channel-mapped items (e.g. facebook_page → FACEBOOK channel)
  const channelRefItems = items.filter((i) => i.channelRef);
  /** @type {Record<string, { connectionStatus: WorkspaceConnectionStatus, displayName: string | null }>} */
  const channelStateMap = {};
  for (const item of channelRefItems) {
    try {
      const channelConn = await getConnection(workspaceId, item.channelRef);
      channelStateMap[item.providerKey] = {
        connectionStatus: channelConn?.status === "CONNECTED" ? "connected" : "not_connected",
        displayName: channelConn?.displayName ?? null,
      };
    } catch {
      // Channel not yet in enum (e.g. GOOGLE) — treat as not_connected
      channelStateMap[item.providerKey] = {
        connectionStatus: "not_connected",
        displayName: null,
      };
    }
  }

  // 4b. Resolve "managed" items (e.g. listing_feed → WorkspaceDataSource records)
  const managedItems = items.filter((i) => i.connectionMode === "managed");
  /** @type {Record<string, { connectionStatus: WorkspaceConnectionStatus, sourceCount: number, listingCount: number }>} */
  const managedStateMap = {};
  if (managedItems.some((i) => i.providerKey === "listing_feed")) {
    const listingSources = await prisma.workspaceDataSource.findMany({
      where: { clientId: workspaceId, type: { in: ["URL", "CSV", "MANUAL"] } },
      include: { _count: { select: { dataItems: true } } },
    });
    // Exclude CRM/GBP sources by name
    const filtered = listingSources.filter((s) => {
      const name = (s.name || "").toLowerCase();
      return !name.includes("crm") && !name.includes("gbp");
    });
    const sourceCount = filtered.length;
    const listingCount = filtered.reduce((n, s) => n + s._count.dataItems, 0);
    managedStateMap["listing_feed"] = {
      connectionStatus: sourceCount > 0 ? "connected" : "not_connected",
      sourceCount,
      listingCount,
    };
  }

  // 5. Merge
  const isRealEstate = client.industryKey === "real_estate";

  return items.map((item) => {
    const caps = item.capabilities;
    // For channel-mapped items, derive state from the channel platform
    const channelState = channelStateMap[item.providerKey];
    const managedState = managedStateMap[item.providerKey];
    const conn = connectionDetailMap[item.providerKey];
    const connectionStatus = channelState?.connectionStatus ?? managedState?.connectionStatus ?? conn?.connectionStatus ?? "not_connected";
    const connMode = item.connectionMode ?? "planned";

    // Compute usedFor + nextAction from capability map (real estate only)
    const capEntry = isRealEstate ? RE_CAPABILITY_MAP[item.providerKey] : null;
    const usedFor = capEntry?.usedFor ?? undefined;

    let nextAction = undefined;
    if (connMode === "managed") {
      nextAction = { label: connectionStatus === "connected" ? "Manage" : "Add sources", action: "navigate", navigateTo: item.managedIn };
    } else if (connectionStatus !== "connected") {
      if (connMode === "manual") {
        nextAction = { label: "Set up", action: "manual_setup" };
      } else if (connMode === "oauth" && item.status === "live") {
        nextAction = { label: "Connect", action: "oauth_connect" };
      } else if (connMode === "oauth" && item.status === "planned") {
        nextAction = { label: "Coming soon", action: "planned" };
      } else if (connMode === "planned") {
        nextAction = { label: "Coming soon", action: "planned" };
      }
    }

    // Compute statusSummary — short human-readable state text
    const metadata = managedState
      ? { sourceCount: managedState.sourceCount, listingCount: managedState.listingCount }
      : channelState
        ? (channelState.displayName ? { displayName: channelState.displayName } : null)
        : (conn?.metadataJson ?? null);

    let statusSummary = undefined;
    if (isRealEstate) {
      statusSummary = buildRealEstateStatusSummary(item.providerKey, connectionStatus, metadata, channelState);
    }

    return {
      providerKey: item.providerKey,
      label: item.label,
      description: item.description,
      priority: item.priority,
      status: item.status,
      category: item.category,
      capabilities: caps,
      connectionMode: connMode,
      manualSetup: item.manualSetup ?? undefined,
      managedIn: item.managedIn ?? undefined,
      channelRef: item.channelRef ?? undefined,
      connectionStatus,
      metadataJson: metadata,
      isPublishing: caps.includes("publishing") || caps.includes("scheduling_target"),
      isImportSource: caps.includes("imports") || caps.includes("content_source"),
      isWorkflowTool:
        caps.includes("workflow_trigger") ||
        caps.includes("document_source") ||
        caps.includes("client_sync") ||
        caps.includes("lead_sync"),
      ...(usedFor !== undefined && { usedFor }),
      ...(nextAction !== undefined && { nextAction }),
      ...(statusSummary !== undefined && { statusSummary }),
    };
  });
}

// ── Content context for AI generation ────────────────────────────────

/**
 * @typedef {Object} TechStackContentContext
 * @property {boolean} hasWebsite
 * @property {string | null} websiteUrl
 * @property {boolean} hasFacebook
 * @property {string | null} facebookPageName
 * @property {boolean} hasInstagram
 * @property {string | null} instagramAccountName
 * @property {string[]} connectedTools - Labels of all connected tech stack items
 * @property {string[]} connectedCapabilities - Deduplicated capabilities across all connected items
 */

/**
 * Build a lightweight content context from the workspace's connected tech stack.
 * Used by the AI generation system to make prompts aware of connected tools.
 *
 * @param {string} workspaceId
 * @returns {Promise<TechStackContentContext>}
 */
export async function buildTechStackContentContext(workspaceId) {
  const view = await getWorkspaceTechStackView(workspaceId);
  const connected = view.filter((i) => i.connectionStatus === "connected");

  // Extract specific tool flags
  const website = connected.find((i) => i.providerKey === "idx_website");
  const facebook = connected.find((i) => i.providerKey === "facebook_page");
  const instagram = connected.find((i) => i.providerKey === "instagram_business");

  // Deduplicate capabilities across all connected items
  const capSet = new Set();
  for (const item of connected) {
    for (const cap of item.capabilities) capSet.add(cap);
  }

  return {
    hasWebsite: !!website,
    websiteUrl: website?.metadataJson?.url ?? null,
    hasFacebook: !!facebook,
    facebookPageName: facebook?.metadataJson?.displayName ?? null,
    hasInstagram: !!instagram,
    instagramAccountName: instagram?.metadataJson?.displayName ?? null,
    connectedTools: connected.map((i) => i.label),
    connectedCapabilities: [...capSet],
  };
}

// ── Real estate canonical context (re-export) ──────────────────────
export { resolveRealEstateContext } from "./realEstateContext.js";

// ── Mutation helpers ────────────────────────────────────────────────

/**
 * Upsert a workspace tech stack connection.
 * @param {string} workspaceId
 * @param {string} providerKey
 * @param {WorkspaceConnectionStatus} status
 * @param {{ metadataJson?: object, lastError?: string | null }} [extra]
 */
export async function upsertWorkspaceTechStackConnection(
  workspaceId,
  providerKey,
  status,
  extra = {},
) {
  const data = {
    connectionStatus: status,
    ...(extra.metadataJson !== undefined && { metadataJson: extra.metadataJson }),
    ...(extra.lastError !== undefined && { lastError: extra.lastError }),
    ...(status === "connected" && { connectedAt: new Date() }),
  };

  return prisma.workspaceTechStackConnection.upsert({
    where: {
      workspaceId_providerKey: { workspaceId, providerKey },
    },
    create: {
      workspaceId,
      providerKey,
      ...data,
    },
    update: data,
  });
}

/**
 * Set the connection status for a workspace tech stack item.
 * Convenience wrapper around upsert.
 *
 * @param {string} workspaceId
 * @param {string} providerKey
 * @param {WorkspaceConnectionStatus} status
 */
export async function setWorkspaceTechStackConnectionStatus(
  workspaceId,
  providerKey,
  status,
) {
  return upsertWorkspaceTechStackConnection(workspaceId, providerKey, status);
}
