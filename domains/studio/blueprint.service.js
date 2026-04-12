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
