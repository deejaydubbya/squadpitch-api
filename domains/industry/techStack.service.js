// Workspace tech stack connection service.
//
// Reads/writes per-workspace connection state for industry tech stack items.
// Industry config = what tools exist. Workspace state = what the user has connected.

import { prisma } from "../../prisma.js";
import { getIndustryProfile } from "./registry.js";
import { getIndustryTechStack } from "./industry.service.js";
import { getConnection } from "../studio/connection.service.js";

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
    const channelConn = await getConnection(workspaceId, item.channelRef);
    channelStateMap[item.providerKey] = {
      connectionStatus: channelConn?.status === "CONNECTED" ? "connected" : "not_connected",
      displayName: channelConn?.displayName ?? null,
    };
  }

  // 5. Merge
  return items.map((item) => {
    const caps = item.capabilities;
    // For channel-mapped items, derive state from the channel platform
    const channelState = channelStateMap[item.providerKey];
    const conn = connectionDetailMap[item.providerKey];
    return {
      providerKey: item.providerKey,
      label: item.label,
      description: item.description,
      priority: item.priority,
      status: item.status,
      category: item.category,
      capabilities: caps,
      connectionMode: item.connectionMode ?? "planned",
      manualSetup: item.manualSetup ?? undefined,
      channelRef: item.channelRef ?? undefined,
      connectionStatus: channelState?.connectionStatus ?? conn?.connectionStatus ?? "not_connected",
      metadataJson: channelState
        ? (channelState.displayName ? { displayName: channelState.displayName } : null)
        : (conn?.metadataJson ?? null),
      isPublishing: caps.includes("publishing") || caps.includes("scheduling_target"),
      isImportSource: caps.includes("imports") || caps.includes("content_source"),
      isWorkflowTool:
        caps.includes("workflow_trigger") ||
        caps.includes("document_source") ||
        caps.includes("client_sync") ||
        caps.includes("lead_sync"),
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
