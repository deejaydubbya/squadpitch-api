// Content blueprint query service.

import { prisma } from "../../prisma.js";

export function formatBlueprint(bp) {
  if (!bp) return null;
  return {
    id: bp.id,
    slug: bp.slug,
    name: bp.name,
    description: bp.description,
    category: bp.category,
    promptTemplate: bp.promptTemplate,
    applicableTypes: bp.applicableTypes,
    applicableChannels: bp.applicableChannels,
    isActive: bp.isActive,
    createdAt: bp.createdAt,
    updatedAt: bp.updatedAt,
  };
}

export async function listBlueprints({ category, applicableType, channel } = {}) {
  const where = { isActive: true };

  if (category) where.category = category;
  if (applicableType) where.applicableTypes = { has: applicableType };
  if (channel) where.applicableChannels = { has: channel };

  return prisma.contentBlueprint.findMany({
    where,
    orderBy: { name: "asc" },
  });
}

export async function getBlueprint(id) {
  return prisma.contentBlueprint.findUnique({ where: { id } });
}

export async function getBlueprintBySlug(slug) {
  return prisma.contentBlueprint.findUnique({ where: { slug } });
}

/**
 * Pick the best ContentBlueprint for a given data-item type +
 * (optionally) a channel set, for injection into the campaign
 * prompt as a STRUCTURE EXAMPLE.
 *
 * Selection rules:
 *   - blueprint must be active
 *   - applicableTypes must include the data-item type
 *   - if `channels` is non-empty, prefer a blueprint whose
 *     applicableChannels intersects with one of them. If none match,
 *     fall back to any type-matching blueprint (channel matching is
 *     "nice to have", type matching is required).
 *
 * Returns `null` when no active blueprint matches the type — the
 * caller should treat that as "no structure example to inject" and
 * let the existing prompt logic flow through.
 */
export async function findBestBlueprintForItem({
  dataItemType,
  channels = [],
} = {}) {
  if (!dataItemType) return null;

  // Type-matching blueprints are required; channel match is a bonus.
  const typeMatches = await prisma.contentBlueprint.findMany({
    where: {
      isActive: true,
      applicableTypes: { has: dataItemType },
    },
    orderBy: { name: "asc" },
  });
  if (typeMatches.length === 0) return null;

  // Prefer the first blueprint whose applicableChannels include one
  // of the target channels.
  if (Array.isArray(channels) && channels.length > 0) {
    const channelSet = new Set(channels);
    const channelMatch = typeMatches.find((bp) =>
      Array.isArray(bp.applicableChannels) &&
      bp.applicableChannels.some((ch) => channelSet.has(ch))
    );
    if (channelMatch) return channelMatch;
  }

  // No channel match — return the first type-matching blueprint.
  return typeMatches[0];
}
