// Workspace tech stack connection service.
//
// Reads/writes per-workspace connection state for industry tech stack items.
// Industry config = what tools exist. Workspace state = what the user has connected.

import { prisma } from "../../prisma.js";
import { getIndustryProfile } from "./registry.js";
import { getIndustryTechStack } from "./industry.service.js";

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
 * @property {WorkspaceConnectionStatus} connectionStatus
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

  // 3. Get workspace connections
  const connectionMap = await getWorkspaceTechStackConnectionMap(workspaceId);

  // 4. Merge
  return items.map((item) => {
    const caps = item.capabilities;
    return {
      providerKey: item.providerKey,
      label: item.label,
      description: item.description,
      priority: item.priority,
      status: item.status,
      category: item.category,
      capabilities: caps,
      connectionMode: item.connectionMode ?? "planned",
      connectionStatus: connectionMap[item.providerKey] ?? "not_connected",
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
