// Feature flag management service.

import { prisma } from "../../prisma.js";

// ── List / Query ────────────────────────────────────────────────────────

export async function listFlags({ category, enabled, search, limit = 100 }) {
  const where = {};

  if (category) where.category = category;
  if (typeof enabled === "boolean") where.enabled = enabled;
  if (search) {
    where.OR = [
      { key: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  return prisma.featureFlag.findMany({
    where,
    orderBy: [{ category: "asc" }, { key: "asc" }],
    take: limit,
  });
}

export async function getFlag(id) {
  return prisma.featureFlag.findUnique({ where: { id } });
}

export async function getFlagByKey(key) {
  return prisma.featureFlag.findUnique({ where: { key } });
}

// ── Create / Update ─────────────────────────────────────────────────────

export async function createFlag(data, adminId) {
  return prisma.featureFlag.create({
    data: {
      key: data.key,
      name: data.name,
      description: data.description || null,
      category: data.category || "feature",
      enabled: data.enabled ?? false,
      scope: data.scope || "global",
      targetType: data.targetType || null,
      targetIds: data.targetIds || [],
      rolloutPercentage: data.rolloutPercentage ?? null,
      notes: data.notes || null,
      createdBy: adminId || null,
      updatedBy: adminId || null,
    },
  });
}

export async function updateFlag(id, data, adminId) {
  const update = { updatedBy: adminId || undefined };

  if (data.name !== undefined) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;
  if (data.category !== undefined) update.category = data.category;
  if (typeof data.enabled === "boolean") update.enabled = data.enabled;
  if (data.scope !== undefined) update.scope = data.scope;
  if (data.targetType !== undefined) update.targetType = data.targetType;
  if (data.targetIds !== undefined) update.targetIds = data.targetIds;
  if (data.rolloutPercentage !== undefined) update.rolloutPercentage = data.rolloutPercentage;
  if (data.notes !== undefined) update.notes = data.notes;

  return prisma.featureFlag.update({
    where: { id },
    data: update,
  });
}

export async function toggleFlag(id, enabled, adminId) {
  return prisma.featureFlag.update({
    where: { id },
    data: { enabled, updatedBy: adminId || null },
  });
}

export async function deleteFlag(id) {
  return prisma.featureFlag.delete({ where: { id } });
}

// ── Evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate whether a flag is active for a given context.
 * @param {string} key - Flag key
 * @param {{ userId?: string, workspaceId?: string, cohort?: string }} ctx
 * @returns {Promise<boolean>}
 */
export async function evaluateFlag(key, ctx = {}) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  if (!flag || !flag.enabled) return false;

  // Global scope — enabled for everyone
  if (flag.scope === "global") return true;

  // Targeted scope
  if (flag.scope === "targeted" && flag.targetType && flag.targetIds.length > 0) {
    switch (flag.targetType) {
      case "workspace":
        return ctx.workspaceId ? flag.targetIds.includes(ctx.workspaceId) : false;
      case "user":
        return ctx.userId ? flag.targetIds.includes(ctx.userId) : false;
      case "cohort":
        return ctx.cohort ? flag.targetIds.includes(ctx.cohort) : false;
      default:
        return false;
    }
  }

  // Rollout percentage
  if (flag.rolloutPercentage != null && flag.rolloutPercentage < 100) {
    // Deterministic hash based on flag key + user/workspace
    const seed = ctx.userId || ctx.workspaceId || "global";
    const hash = simpleHash(`${flag.key}:${seed}`);
    return (hash % 100) < flag.rolloutPercentage;
  }

  return true;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

// ── Seed ────────────────────────────────────────────────────────────────

const SEED_FLAGS = [
  {
    key: "video_gen_beta",
    name: "Video Generation Beta",
    description: "Enable video generation features for selected workspaces",
    category: "feature",
    scope: "targeted",
    targetType: "cohort",
    targetIds: ["alpha"],
  },
  {
    key: "new_onboarding_flow",
    name: "New Onboarding Flow",
    description: "Redesigned workspace setup and brand extraction flow",
    category: "rollout",
    scope: "global",
  },
  {
    key: "autopilot_v2",
    name: "Autopilot V2 Logic",
    description: "New autopilot scheduling engine with smarter content selection",
    category: "feature",
    scope: "targeted",
    targetType: "workspace",
    targetIds: [],
  },
  {
    key: "new_channel_center",
    name: "New Channel Center UX",
    description: "Redesigned channel management and connection flow",
    category: "rollout",
    scope: "global",
  },
  {
    key: "content_library_v2",
    name: "Content Library V2",
    description: "New planner and content library UX with drag-and-drop calendar",
    category: "feature",
    scope: "targeted",
    targetType: "cohort",
    targetIds: ["beta-1"],
  },
  {
    key: "industry_experiments",
    name: "Industry-Specific Experiments",
    description: "Enable experimental industry-specific features (automotive, hospitality)",
    category: "experiment",
    scope: "targeted",
    targetType: "workspace",
    targetIds: [],
  },
  {
    key: "tester_features",
    name: "Tester-Only Features",
    description: "Features accessible only to beta testers for early feedback",
    category: "feature",
    scope: "targeted",
    targetType: "cohort",
    targetIds: ["alpha", "beta-1"],
  },
  {
    key: "pause_ai_generation",
    name: "Pause AI Generation",
    description: "Emergency toggle to pause all AI content generation globally",
    category: "ops",
    scope: "global",
  },
  {
    key: "disable_video_generation",
    name: "Disable Video Generation",
    description: "Toggle to disable video generation (budget or provider issues)",
    category: "ops",
    scope: "global",
  },
  {
    key: "maintenance_mode",
    name: "Maintenance Mode",
    description: "Show maintenance banner and disable non-critical operations",
    category: "ops",
    scope: "global",
  },
];

export async function seedFlags() {
  let created = 0;
  for (const flag of SEED_FLAGS) {
    const exists = await prisma.featureFlag.findUnique({ where: { key: flag.key } });
    if (!exists) {
      await prisma.featureFlag.create({
        data: {
          ...flag,
          enabled: false,
          targetIds: flag.targetIds || [],
        },
      });
      created++;
    }
  }

  const total = await prisma.featureFlag.count();
  return { created, total };
}
