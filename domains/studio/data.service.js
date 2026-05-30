// Business data item CRUD service.

import { prisma } from "../../prisma.js";

// ── Helpers ─────────────────────────────────────────────────────────────

export function formatDataSource(source) {
  if (!source) return null;
  return {
    id: source.id,
    clientId: source.clientId,
    type: source.type,
    name: source.name,
    config: source.config,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export function formatDataItem(item) {
  if (!item) return null;
  const out = {
    id: item.id,
    clientId: item.clientId,
    dataSourceId: item.dataSourceId,
    type: item.type,
    status: item.status,
    title: item.title,
    summary: item.summary,
    dataJson: item.dataJson,
    tags: item.tags,
    priority: item.priority,
    expiresAt: item.expiresAt,
    usageCount: item.usageCount,
    lastUsedAt: item.lastUsedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.performance) {
    out.performance = {
      totalDrafts: item.performance.totalDrafts,
      totalPublished: item.performance.totalPublished,
      avgEngagement: item.performance.avgEngagement,
      lastCalculated: item.performance.lastCalculated,
    };
  } else {
    out.performance = null;
  }
  return out;
}

// ── Data Sources ────────────────────────────────────────────────────────

export async function getOrCreateDefaultSource(clientId) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { clientId, type: "MANUAL" },
  });
  if (existing) return existing;

  return prisma.workspaceDataSource.create({
    data: {
      clientId,
      type: "MANUAL",
      name: "Manual Data",
    },
  });
}

export async function listDataSources(clientId) {
  return prisma.workspaceDataSource.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createDataSource(clientId, { name, type }) {
  return prisma.workspaceDataSource.create({
    data: {
      clientId,
      type: type ?? "MANUAL",
      name,
    },
  });
}

// ── Data Items ──────────────────────────────────────────────────────────

export async function createDataItem(clientId, input) {
  const dataSourceId =
    input.dataSourceId ?? (await getOrCreateDefaultSource(clientId)).id;

  return prisma.workspaceDataItem.create({
    data: {
      clientId,
      dataSourceId,
      type: input.type,
      title: input.title,
      summary: input.summary ?? null,
      dataJson: input.dataJson ?? {},
      tags: input.tags ?? [],
      priority: input.priority ?? 0,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    },
  });
}

export async function listDataItems(
  clientId,
  { type, excludeTypes, status, search, limit } = {}
) {
  const where = { clientId };
  if (status) where.status = status;
  else where.status = "ACTIVE";
  if (type) {
    where.type = type;
  } else if (Array.isArray(excludeTypes) && excludeTypes.length > 0) {
    // Spinstr425 — Content Assets passes excludeTypes=PROPERTY so
    // property rows stay confined to the Properties tab. Server-side
    // (not client-side) so pagination doesn't truncate the wrong
    // bucket on workspaces with lots of listings.
    where.type = { notIn: excludeTypes };
  }
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { summary: { contains: search, mode: "insensitive" } },
    ];
  }

  return prisma.workspaceDataItem.findMany({
    where,
    include: { performance: true },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: limit ?? 100,
  });
}

// Workspace-scoped item lookup. Every caller must pass the clientId
// that the request was authenticated against — defense in depth on
// top of requireClientOwner + assertDataItemInClient at the route
// layer. findFirst with the composite filter means a stolen item id
// from another workspace returns null rather than the row.
export async function getDataItem(clientId, id) {
  if (!clientId) {
    throw new Error("getDataItem requires clientId — fix the caller");
  }
  return prisma.workspaceDataItem.findFirst({
    where: { id, clientId },
    include: { performance: true },
  });
}

export async function updateDataItem(clientId, id, patch) {
  if (!clientId) {
    throw new Error("updateDataItem requires clientId — fix the caller");
  }
  const data = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.summary !== undefined) data.summary = patch.summary;
  if (patch.type !== undefined) data.type = patch.type;
  if (patch.dataJson !== undefined) data.dataJson = patch.dataJson;
  if (patch.tags !== undefined) data.tags = patch.tags;
  if (patch.priority !== undefined) data.priority = patch.priority;
  if (patch.expiresAt !== undefined)
    data.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;

  // updateMany so the clientId scope is part of the WHERE clause.
  // Returns { count } — we re-fetch via getDataItem to keep the
  // existing API response shape.
  const result = await prisma.workspaceDataItem.updateMany({
    where: { id, clientId },
    data,
  });
  if (result.count === 0) return null;
  return getDataItem(clientId, id);
}

export async function archiveDataItem(clientId, id) {
  if (!clientId) {
    throw new Error("archiveDataItem requires clientId — fix the caller");
  }
  const result = await prisma.workspaceDataItem.updateMany({
    where: { id, clientId },
    data: { status: "ARCHIVED" },
  });
  if (result.count === 0) return null;
  return getDataItem(clientId, id);
}

export async function deleteDataItem(clientId, id) {
  if (!clientId) {
    throw new Error("deleteDataItem requires clientId — fix the caller");
  }
  // deleteMany so the composite where clause is honored. Returns 0
  // when the item belongs to a different workspace — the route
  // layer translates that to 404.
  const result = await prisma.workspaceDataItem.deleteMany({
    where: { id, clientId },
  });
  return result.count > 0;
}

export async function incrementDataItemUsage(id) {
  return prisma.workspaceDataItem.update({
    where: { id },
    data: {
      usageCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });
}
