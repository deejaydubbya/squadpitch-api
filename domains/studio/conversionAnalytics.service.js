import { prisma } from "../../prisma.js";
import {
  getConversionCountsByType,
  getConversionCountsByChannel,
  getConversionCountsByDraft,
  getConversionRate,
} from "./conversionEvent.service.js";

export async function getConversionsSection({ clientId, since }) {
  const [rateData, byType, byChannel, topDrafts, activeLinks] =
    await Promise.all([
      getConversionRate(clientId, { since }),
      getConversionCountsByType(clientId, { since }),
      getConversionCountsByChannel(clientId, { since }),
      getConversionCountsByDraft(clientId, { since, limit: 5 }),
      prisma.trackableLink.count({ where: { clientId, isActive: true } }),
    ]);

  const formattedByType = byType.map((r) => ({
    type: r.type,
    count: r._count.id,
  }));

  return {
    totalConversions: rateData.totalConversions,
    conversionRate: rateData.conversionRate,
    totalPublishedPosts: rateData.totalPublishedPosts,
    activeLinks,
    byType: formattedByType,
    byChannel,
    topDrafts,
    hasData: rateData.totalConversions > 0 || activeLinks > 0,
  };
}
