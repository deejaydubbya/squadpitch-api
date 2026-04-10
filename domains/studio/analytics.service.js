// Squadpitch per-client analytics.
//
// Aggregates counts / rates / breakdowns directly from the
// Draft table. Lightweight — no worker, no cache. Fine for
// the admin dev portal; can be moved to a materialized view if volumes
// grow.

import { prisma } from "../../prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} clientId
 */
export async function getClientAnalytics(clientId) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) {
    throw Object.assign(new Error("Client not found"), {
      status: 404,
      code: "CLIENT_NOT_FOUND",
    });
  }

  const [
    byStatusRaw,
    byKindRaw,
    byChannelRaw,
    recent,
  ] = await Promise.all([
    prisma.draft.groupBy({
      by: ["status"],
      where: { clientId },
      _count: { _all: true },
    }),
    prisma.draft.groupBy({
      by: ["kind"],
      where: { clientId },
      _count: { _all: true },
    }),
    prisma.draft.groupBy({
      by: ["channel"],
      where: { clientId },
      _count: { _all: true },
    }),
    prisma.draft.findMany({
      where: {
        clientId,
        createdAt: { gte: new Date(Date.now() - 14 * DAY_MS) },
      },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const byStatus = byStatusRaw.reduce((acc, row) => {
    acc[row.status] = row._count._all;
    return acc;
  }, {});

  const byKind = byKindRaw.reduce((acc, row) => {
    acc[row.kind] = row._count._all;
    return acc;
  }, {});

  const byChannel = byChannelRaw.reduce((acc, row) => {
    acc[row.channel] = row._count._all;
    return acc;
  }, {});

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const nonFailed = total - (byStatus.FAILED ?? 0);
  const approved = (byStatus.APPROVED ?? 0) + (byStatus.PUBLISHED ?? 0) + (byStatus.SCHEDULED ?? 0);
  const rejected = byStatus.REJECTED ?? 0;

  const approvalRate = nonFailed > 0 ? approved / nonFailed : 0;
  const rejectionRate = nonFailed > 0 ? rejected / nonFailed : 0;

  // Build a 14-day daily series, filled with zeros for empty days.
  const series = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, count: 0 });
  }
  const dayIndex = new Map(series.map((pt, i) => [pt.date, i]));
  for (const row of recent) {
    const key = row.createdAt.toISOString().slice(0, 10);
    const idx = dayIndex.get(key);
    if (idx !== undefined) series[idx].count += 1;
  }

  return {
    total,
    byStatus,
    byKind,
    byChannel,
    approvalRate,
    rejectionRate,
    last14Days: series,
  };
}
