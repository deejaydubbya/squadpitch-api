import crypto from "crypto";
import { prisma } from "../../prisma.js";

const API_URL = process.env.API_URL || "https://squadpitch-api.fly.dev";

export function generateShortCode() {
  return crypto.randomBytes(6).toString("base64url"); // 8 chars
}

export function buildRedirectUrl(shortCode) {
  return `${API_URL}/r/${shortCode}`;
}

export async function createTrackableLink({
  clientId,
  draftId,
  destinationUrl,
  label,
  channel,
  utmSource,
  utmMedium,
  utmCampaign,
  utmTerm,
  utmContent,
  createdBy,
}) {
  const shortCode = generateShortCode();
  const link = await prisma.trackableLink.create({
    data: {
      clientId,
      draftId: draftId || null,
      shortCode,
      destinationUrl,
      label: label || null,
      channel: channel || null,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmTerm: utmTerm || null,
      utmContent: utmContent || null,
      createdBy,
    },
  });
  return { ...link, redirectUrl: buildRedirectUrl(shortCode) };
}

export async function listTrackableLinks(clientId, { draftId } = {}) {
  const where = { clientId, isActive: true };
  if (draftId) where.draftId = draftId;
  const links = await prisma.trackableLink.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return links.map((l) => ({ ...l, redirectUrl: buildRedirectUrl(l.shortCode) }));
}

export async function resolveShortCode(shortCode) {
  return prisma.trackableLink.findFirst({
    where: { shortCode, isActive: true },
  });
}

export async function incrementClickCount(id) {
  return prisma.trackableLink.update({
    where: { id },
    data: { clickCount: { increment: 1 } },
  });
}

export async function deleteLink(id) {
  return prisma.trackableLink.delete({ where: { id } });
}
