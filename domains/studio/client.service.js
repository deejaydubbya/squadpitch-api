// Client CRUD + profile sub-table upserts for Squadpitch.
//
// Owns all Prisma reads/writes for Client,
// BrandProfile, VoiceProfile,
// MediaProfile, and ChannelSettings.

import { prisma } from "../../prisma.js";
import { invalidateClientContext } from "./generation/clientOrchestrator.js";

// -- Clients -----------------------------------------------------------------

export async function listClients(userId) {
  return prisma.client.findMany({
    where: { createdBy: userId, status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { drafts: true },
      },
    },
  });
}

export async function getClient(clientId, userId) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      brandProfile: true,
      voiceProfile: true,
      mediaProfile: true,
      channelSettings: true,
      _count: { select: { drafts: true } },
    },
  });
  if (client && userId && client.createdBy !== userId) {
    throw forbidden();
  }
  return client;
}

function notFound() {
  return Object.assign(new Error("Client not found"), {
    status: 404,
    code: "CLIENT_NOT_FOUND",
  });
}

function forbidden() {
  return Object.assign(new Error("Forbidden"), {
    status: 403,
    code: "FORBIDDEN",
  });
}

export async function createClient(data, createdBy) {
  const baseSlug = data.slug;
  let slug = baseSlug;

  // If slug already exists (including archived clients), append a numeric suffix
  const existing = await prisma.client.findUnique({ where: { slug } });
  if (existing) {
    let suffix = 2;
    while (true) {
      slug = `${baseSlug}-${suffix}`;
      const taken = await prisma.client.findUnique({ where: { slug } });
      if (!taken) break;
      suffix++;
    }
  }

  return prisma.client.create({
    data: {
      name: data.name,
      slug,
      logoUrl: data.logoUrl ?? null,
      industryKey: data.industryKey ?? null,
      status: data.status ?? "ACTIVE",
      createdBy,
    },
  });
}

export async function updateClient(clientId, patch, userId) {
  const existing = await prisma.client.findUnique({
    where: { id: clientId },
  });
  if (!existing) throw notFound();
  if (userId && existing.createdBy !== userId) throw forbidden();

  return prisma.client.update({
    where: { id: clientId },
    data: patch,
  });
}

export async function archiveClient(clientId, userId) {
  const existing = await prisma.client.findUnique({
    where: { id: clientId },
  });
  if (!existing) throw notFound();
  if (userId && existing.createdBy !== userId) throw forbidden();

  return prisma.client.update({
    where: { id: clientId },
    data: { status: "ARCHIVED" },
  });
}

// -- Brand profile -----------------------------------------------------------

export async function getBrandProfile(clientId) {
  return prisma.brandProfile.findUnique({
    where: { clientId },
  });
}

export async function upsertBrandProfile(clientId, data, updatedBy) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) throw notFound();

  const result = await prisma.brandProfile.upsert({
    where: { clientId },
    create: {
      clientId,
      description: data.description ?? null,
      industry: data.industry ?? null,
      audience: data.audience ?? null,
      website: data.website ?? null,
      socialsJson: data.socialsJson ?? null,
      offers: data.offers ?? null,
      competitors: data.competitors ?? null,
      examplePosts: data.examplePosts ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      marketArea: data.marketArea ?? null,
      primaryZip: data.primaryZip ?? null,
      serviceAreas: data.serviceAreas ?? null,
      updatedBy: updatedBy ?? null,
    },
    update: {
      description: data.description ?? null,
      industry: data.industry ?? null,
      audience: data.audience ?? null,
      website: data.website ?? null,
      socialsJson: data.socialsJson ?? null,
      offers: data.offers ?? null,
      competitors: data.competitors ?? null,
      examplePosts: data.examplePosts ?? null,
      city: data.city ?? undefined,
      state: data.state ?? undefined,
      marketArea: data.marketArea ?? undefined,
      primaryZip: data.primaryZip ?? undefined,
      serviceAreas: data.serviceAreas ?? undefined,
      updatedBy: updatedBy ?? null,
    },
  });
  invalidateClientContext(clientId).catch(() => {});
  return result;
}

// -- Voice profile -----------------------------------------------------------

export async function getVoiceProfile(clientId) {
  return prisma.voiceProfile.findUnique({
    where: { clientId },
  });
}

export async function upsertVoiceProfile(clientId, data, updatedBy) {
  const existing = await prisma.voiceProfile.findUnique({
    where: { clientId },
  });

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) throw notFound();

  const payload = {
    tone: data.tone ?? null,
    voiceRulesJson: data.voiceRulesJson ?? { do: [], dont: [] },
    bannedPhrases: data.bannedPhrases ?? [],
    ctaPreferences: data.ctaPreferences ?? null,
    contentBuckets: data.contentBuckets ?? [],
    updatedBy: updatedBy ?? null,
  };

  let result;
  if (existing) {
    result = await prisma.voiceProfile.update({
      where: { clientId },
      data: {
        ...payload,
        version: existing.version + 1,
      },
    });
  } else {
    result = await prisma.voiceProfile.create({
      data: {
        clientId,
        ...payload,
        version: 1,
      },
    });
  }
  invalidateClientContext(clientId).catch(() => {});
  return result;
}

// -- Media profile -----------------------------------------------------------

export async function getMediaProfile(clientId) {
  return prisma.mediaProfile.findUnique({
    where: { clientId },
  });
}

export async function upsertMediaProfile(clientId, data, updatedBy) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) throw notFound();

  const result = await prisma.mediaProfile.upsert({
    where: { clientId },
    create: {
      clientId,
      mode: data.mode ?? "BRAND_ASSETS_ONLY",
      visualStyle: data.visualStyle ?? null,
      assetLibraryJson: data.assetLibraryJson ?? null,
      characterPrompt: data.characterPrompt ?? null,
      basePromptTemplate: data.basePromptTemplate ?? null,
      loraModelUrl: data.loraModelUrl ?? null,
      loraTriggerWord: data.loraTriggerWord ?? null,
      loraScale: data.loraScale ?? 1.0,
      updatedBy: updatedBy ?? null,
    },
    update: {
      mode: data.mode ?? "BRAND_ASSETS_ONLY",
      visualStyle: data.visualStyle ?? null,
      assetLibraryJson: data.assetLibraryJson ?? null,
      characterPrompt: data.characterPrompt ?? null,
      basePromptTemplate: data.basePromptTemplate ?? null,
      loraModelUrl: data.loraModelUrl ?? null,
      loraTriggerWord: data.loraTriggerWord ?? null,
      loraScale: data.loraScale ?? 1.0,
      updatedBy: updatedBy ?? null,
    },
  });
  invalidateClientContext(clientId).catch(() => {});
  return result;
}

// -- Channel settings --------------------------------------------------------

export async function listChannelSettings(clientId) {
  return prisma.channelSettings.findMany({
    where: { clientId },
    orderBy: { channel: "asc" },
  });
}

/**
 * Bulk upsert a list of channel settings for a client. Atomic transaction
 * so a partial write never happens.
 */
export async function upsertChannelSettings(clientId, items) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) throw notFound();

  const result = await prisma.$transaction(
    items.map((item) =>
      prisma.channelSettings.upsert({
        where: {
          clientId_channel: { clientId, channel: item.channel },
        },
        create: {
          clientId,
          channel: item.channel,
          isEnabled: item.isEnabled ?? true,
          maxChars: item.maxChars ?? null,
          allowEmoji: item.allowEmoji ?? true,
          trailingHashtags: item.trailingHashtags ?? [],
          notes: item.notes ?? null,
        },
        update: {
          isEnabled: item.isEnabled ?? true,
          maxChars: item.maxChars ?? null,
          allowEmoji: item.allowEmoji ?? true,
          trailingHashtags: item.trailingHashtags ?? [],
          notes: item.notes ?? null,
        },
      })
    )
  );
  invalidateClientContext(clientId).catch(() => {});
  return result;
}

// -- Formatters --------------------------------------------------------------

export function formatClient(client) {
  if (!client) return null;
  return {
    id: client.id,
    name: client.name,
    slug: client.slug,
    status: client.status,
    logoUrl: client.logoUrl,
    industryKey: client.industryKey ?? null,
    createdBy: client.createdBy,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    draftCount: client._count?.drafts ?? 0,
    brandProfile: client.brandProfile ? formatBrandProfile(client.brandProfile) : null,
    voiceProfile: client.voiceProfile ? formatVoiceProfile(client.voiceProfile) : null,
    mediaProfile: client.mediaProfile ? formatMediaProfile(client.mediaProfile) : null,
    channelSettings: Array.isArray(client.channelSettings)
      ? client.channelSettings.map(formatChannelSettings)
      : undefined,
  };
}

export function formatBrandProfile(brand) {
  if (!brand) return null;
  return {
    clientId: brand.clientId,
    description: brand.description,
    industry: brand.industry,
    audience: brand.audience,
    website: brand.website,
    socialsJson: brand.socialsJson,
    offers: brand.offers,
    competitors: brand.competitors,
    examplePosts: brand.examplePosts,
    city: brand.city ?? null,
    state: brand.state ?? null,
    marketArea: brand.marketArea ?? null,
    primaryZip: brand.primaryZip ?? null,
    serviceAreas: brand.serviceAreas ?? null,
    updatedBy: brand.updatedBy,
    updatedAt: brand.updatedAt,
  };
}

export function formatVoiceProfile(voice) {
  if (!voice) return null;
  return {
    clientId: voice.clientId,
    tone: voice.tone,
    voiceRulesJson: voice.voiceRulesJson,
    bannedPhrases: voice.bannedPhrases,
    ctaPreferences: voice.ctaPreferences,
    contentBuckets: voice.contentBuckets,
    version: voice.version,
    updatedBy: voice.updatedBy,
    updatedAt: voice.updatedAt,
  };
}

export function formatMediaProfile(media) {
  if (!media) return null;
  return {
    clientId: media.clientId,
    mode: media.mode,
    visualStyle: media.visualStyle,
    assetLibraryJson: media.assetLibraryJson,
    characterPrompt: media.characterPrompt,
    basePromptTemplate: media.basePromptTemplate,
    loraModelUrl: media.loraModelUrl,
    loraTriggerWord: media.loraTriggerWord,
    loraScale: media.loraScale,
    updatedBy: media.updatedBy,
    updatedAt: media.updatedAt,
  };
}

export function formatChannelSettings(cs) {
  if (!cs) return null;
  return {
    id: cs.id,
    clientId: cs.clientId,
    channel: cs.channel,
    isEnabled: cs.isEnabled,
    maxChars: cs.maxChars,
    allowEmoji: cs.allowEmoji,
    trailingHashtags: cs.trailingHashtags,
    notes: cs.notes,
    createdAt: cs.createdAt,
    updatedAt: cs.updatedAt,
  };
}
