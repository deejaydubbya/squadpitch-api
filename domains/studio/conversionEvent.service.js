import crypto from "crypto";
import { prisma } from "../../prisma.js";

export function hashValue(val) {
  if (!val) return null;
  return crypto.createHash("sha256").update(val).digest("hex");
}

export async function logClickEvent({
  trackableLinkId,
  clientId,
  draftId,
  ip,
  userAgent,
  referrerUrl,
}) {
  return prisma.conversionEvent.create({
    data: {
      clientId,
      draftId: draftId || null,
      trackableLinkId: trackableLinkId || null,
      type: "LINK_CLICK",
      referrerUrl: referrerUrl || null,
      userAgentHash: hashValue(userAgent),
      ipHash: hashValue(ip),
    },
  });
}

export async function logConversionEvent({
  clientId,
  draftId,
  trackableLinkId,
  type,
  label,
  metadata,
}) {
  return prisma.conversionEvent.create({
    data: {
      clientId,
      draftId: draftId || null,
      trackableLinkId: trackableLinkId || null,
      type,
      label: label || null,
      metadata: metadata || null,
    },
  });
}

export async function getConversionCountsByType(clientId, { since } = {}) {
  const where = { clientId };
  if (since) where.createdAt = { gte: since };
  return prisma.conversionEvent.groupBy({
    by: ["type"],
    where,
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
  });
}

export async function getConversionCountsByChannel(clientId, { since } = {}) {
  const dateFilter = since ? { createdAt: { gte: since } } : {};
  const results = await prisma.conversionEvent.findMany({
    where: { clientId, draftId: { not: null }, ...dateFilter },
    select: {
      draft: { select: { channel: true } },
    },
  });

  const counts = {};
  for (const r of results) {
    if (!r.draft?.channel) continue;
    counts[r.draft.channel] = (counts[r.draft.channel] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);
}

export async function getConversionCountsByDraft(clientId, { since, limit = 10 } = {}) {
  const dateFilter = since ? { createdAt: { gte: since } } : {};
  const results = await prisma.conversionEvent.groupBy({
    by: ["draftId"],
    where: { clientId, draftId: { not: null }, ...dateFilter },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: limit,
  });

  if (results.length === 0) return [];

  const draftIds = results.map((r) => r.draftId);
  const drafts = await prisma.draft.findMany({
    where: { id: { in: draftIds } },
    select: { id: true, body: true, channel: true },
  });
  const draftMap = Object.fromEntries(drafts.map((d) => [d.id, d]));

  return results.map((r) => ({
    draftId: r.draftId,
    body: draftMap[r.draftId]?.body?.slice(0, 200) || "",
    channel: draftMap[r.draftId]?.channel || null,
    count: r._count.id,
  }));
}

export async function getConversionRate(clientId, { since } = {}) {
  const dateFilter = since ? { createdAt: { gte: since } } : {};
  const publishedFilter = since ? { publishedAt: { gte: since } } : {};

  const [totalConversions, totalPublished] = await Promise.all([
    prisma.conversionEvent.count({ where: { clientId, ...dateFilter } }),
    prisma.draft.count({
      where: { clientId, status: "PUBLISHED", ...publishedFilter },
    }),
  ]);

  return {
    totalConversions,
    totalPublishedPosts: totalPublished,
    conversionRate: totalPublished > 0 ? totalConversions / totalPublished : null,
  };
}
