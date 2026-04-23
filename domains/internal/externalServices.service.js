import { prisma } from "../../prisma.js";
import { checkBudgetStatus, getAllServicesHealth } from "../billing/serviceHealth.service.js";

// ── CRUD ─────────────────────────────────────────────────────────────────

export async function listServices({ category, status, activeOnly = true }) {
  const where = {};
  if (category) where.category = category;
  if (status) where.status = status;
  if (activeOnly) where.isActive = true;

  return prisma.externalService.findMany({
    where,
    orderBy: [{ criticality: "asc" }, { name: "asc" }],
    include: {
      usageSnapshots: {
        orderBy: { snapshotAt: "desc" },
        take: 1,
      },
    },
  });
}

export async function getService(id) {
  return prisma.externalService.findUnique({
    where: { id },
    include: {
      usageSnapshots: {
        orderBy: { snapshotAt: "desc" },
        take: 30,
      },
    },
  });
}

export async function createService(data) {
  const percentUsed = computePercent(data.currentUsage, data.hardLimit);
  const status = deriveStatus(percentUsed, data.renewalDate);

  return prisma.externalService.create({
    data: {
      ...data,
      percentUsed,
      status: data.status || status,
    },
  });
}

export async function updateService(id, data) {
  // Recompute percent and status if usage/limits changed
  const existing = await prisma.externalService.findUnique({ where: { id } });
  if (!existing) return null;

  const currentUsage = data.currentUsage ?? existing.currentUsage;
  const hardLimit = data.hardLimit ?? existing.hardLimit;
  const renewalDate = data.renewalDate ?? existing.renewalDate;
  const percentUsed = computePercent(currentUsage, hardLimit);

  // Only auto-derive status if it wasn't explicitly set
  const status = data.status || deriveStatus(percentUsed, renewalDate);

  return prisma.externalService.update({
    where: { id },
    data: {
      ...data,
      percentUsed,
      status,
    },
  });
}

export async function deleteService(id) {
  return prisma.externalService.delete({ where: { id } });
}

// ── Usage Snapshots ──────────────────────────────────────────────────────

export async function addUsageSnapshot(serviceId, { usage, limit, note, source }) {
  const percentUsed = computePercent(usage, limit);

  // Create snapshot
  const snapshot = await prisma.externalServiceUsageSnapshot.create({
    data: { serviceId, usage, limit, percentUsed, note, source: source || "manual" },
  });

  // Update the service's current usage
  const status = deriveStatus(percentUsed, null);
  await prisma.externalService.update({
    where: { id: serviceId },
    data: { currentUsage: usage, percentUsed, status },
  });

  return snapshot;
}

// ── Auto-Derived Data ────────────────────────────────────────────────────

/**
 * Pulls live health + budget data for OpenAI and Fal from existing
 * service health infrastructure and updates the corresponding records.
 */
export async function refreshDerivedUsage() {
  const updates = [];

  try {
    const [openaiStatus, falStatus] = await Promise.all([
      checkBudgetStatus("openai").catch(() => null),
      checkBudgetStatus("fal").catch(() => null),
    ]);

    const health = await getAllServicesHealth().catch(() => ({}));

    if (openaiStatus) {
      updates.push(
        upsertDerivedService("openai", {
          currentUsage: openaiStatus.spent / 100, // cents → dollars
          hardLimit: openaiStatus.limit / 100,
          percentUsed: openaiStatus.percentage * 100,
          healthStatus: health.openai || "unknown",
          budgetStatus: openaiStatus.status,
        })
      );
    }

    if (falStatus) {
      updates.push(
        upsertDerivedService("fal", {
          currentUsage: falStatus.spent / 100,
          hardLimit: falStatus.limit / 100,
          percentUsed: falStatus.percentage * 100,
          healthStatus: health.fal || "unknown",
          budgetStatus: falStatus.status,
        })
      );
    }

    await Promise.all(updates);
  } catch (err) {
    console.warn("[externalServices] Failed to refresh derived usage:", err.message);
  }
}

async function upsertDerivedService(key, { currentUsage, hardLimit, percentUsed, healthStatus, budgetStatus }) {
  const service = await prisma.externalService.findUnique({ where: { key } });
  if (!service) return; // Only update if the record exists (seeded)

  const status =
    healthStatus === "down" ? "down" :
    budgetStatus === "exceeded" ? "critical" :
    budgetStatus === "warning" ? "near_limit" :
    healthStatus === "degraded" ? "watch" :
    "healthy";

  await prisma.externalService.update({
    where: { key },
    data: {
      currentUsage,
      hardLimit,
      percentUsed,
      status,
      usageUnit: "dollars",
      usageSource: "derived",
    },
  });

  // Record snapshot
  await prisma.externalServiceUsageSnapshot.create({
    data: {
      serviceId: service.id,
      usage: currentUsage,
      limit: hardLimit,
      percentUsed,
      source: "derived",
    },
  });
}

// ── Summary ──────────────────────────────────────────────────────────────

export async function getServicesSummary() {
  const services = await prisma.externalService.findMany({
    where: { isActive: true },
    select: { status: true, criticality: true, monthlyCostCents: true },
  });

  const totalMonthlyCost = services.reduce((sum, s) => sum + (s.monthlyCostCents || 0), 0);

  return {
    total: services.length,
    healthy: services.filter((s) => s.status === "healthy").length,
    watch: services.filter((s) => s.status === "watch").length,
    nearLimit: services.filter((s) => s.status === "near_limit").length,
    critical: services.filter((s) => s.status === "critical" || s.status === "down").length,
    totalMonthlyCostCents: totalMonthlyCost,
    criticalServices: services.filter((s) => s.criticality === "critical").length,
  };
}

// ── Seed ─────────────────────────────────────────────────────────────────

const SEED_SERVICES = [
  {
    key: "openai",
    name: "OpenAI",
    category: "ai",
    purpose: "Text generation for posts, captions, campaigns, ideas, and parsing",
    criticality: "critical",
    planName: "Pay-as-you-go",
    billingCycle: "usage",
    usageUnit: "dollars",
    usageSource: "derived",
    consoleUrl: "https://platform.openai.com/usage",
    usedByFeatures: "Content generation, campaign AI, ideas, onboarding parser",
  },
  {
    key: "fal",
    name: "fal.ai",
    category: "ai",
    purpose: "Image generation (Flux) and video generation (Kling, MiniMax)",
    criticality: "critical",
    planName: "Pay-as-you-go",
    billingCycle: "usage",
    usageUnit: "dollars",
    usageSource: "derived",
    consoleUrl: "https://fal.ai/dashboard",
    usedByFeatures: "AI image generation, AI video generation, LoRA training",
  },
  {
    key: "auth0",
    name: "Auth0",
    category: "auth",
    purpose: "User authentication, JWT tokens, role-based access",
    criticality: "critical",
    planName: "Free / Essentials",
    billingCycle: "monthly",
    usageUnit: "users",
    consoleUrl: "https://manage.auth0.com/",
    usedByFeatures: "Login, signup, OAuth, admin roles, API auth",
  },
  {
    key: "fly",
    name: "Fly.io",
    category: "infrastructure",
    purpose: "API server hosting, auto-scaling, PostgreSQL",
    criticality: "critical",
    billingCycle: "monthly",
    usageUnit: "dollars",
    consoleUrl: "https://fly.io/dashboard",
    usedByFeatures: "API hosting, database, background workers",
  },
  {
    key: "vercel",
    name: "Vercel",
    category: "infrastructure",
    purpose: "Next.js frontend hosting, edge functions, CDN",
    criticality: "critical",
    billingCycle: "monthly",
    usageUnit: "dollars",
    consoleUrl: "https://vercel.com/dashboard",
    usedByFeatures: "Frontend hosting, API proxy, SSR",
  },
  {
    key: "upstash",
    name: "Upstash Redis",
    category: "infrastructure",
    purpose: "Caching, rate limiting, BullMQ job queues, dedup locks",
    criticality: "critical",
    billingCycle: "monthly",
    usageUnit: "requests",
    consoleUrl: "https://console.upstash.com/",
    usedByFeatures: "Rate limiting, caching, job queues, dedup, health tracking",
  },
  {
    key: "stripe",
    name: "Stripe",
    category: "billing",
    purpose: "Subscription billing, payment processing, plan management",
    criticality: "high",
    planName: "Pay-as-you-go",
    billingCycle: "usage",
    usageUnit: "dollars",
    consoleUrl: "https://dashboard.stripe.com/",
    usedByFeatures: "Subscriptions, checkout, billing portal, webhooks",
  },
  {
    key: "postmark",
    name: "Postmark",
    category: "messaging",
    purpose: "Transactional email delivery (notifications, alerts, digests)",
    criticality: "high",
    billingCycle: "monthly",
    usageUnit: "emails",
    consoleUrl: "https://account.postmarkapp.com/",
    usedByFeatures: "Email notifications, weekly digest, alert emails",
  },
  {
    key: "twilio",
    name: "Twilio",
    category: "messaging",
    purpose: "SMS notifications",
    criticality: "standard",
    planName: "Pay-as-you-go",
    billingCycle: "usage",
    usageUnit: "messages",
    consoleUrl: "https://console.twilio.com/",
    usedByFeatures: "SMS notifications",
  },
  {
    key: "cloudinary",
    name: "Cloudinary",
    category: "infrastructure",
    purpose: "Media asset storage, image/video optimization, CDN delivery",
    criticality: "critical",
    billingCycle: "monthly",
    usageUnit: "gb",
    consoleUrl: "https://console.cloudinary.com/",
    usedByFeatures: "Asset uploads, image optimization, video storage, thumbnails",
  },
  {
    key: "rentcast",
    name: "RentCast",
    category: "data",
    purpose: "Property data enrichment, rent estimates, market data",
    criticality: "standard",
    planName: "Pay-as-you-go",
    billingCycle: "monthly",
    usageUnit: "requests",
    consoleUrl: "https://app.rentcast.io/",
    usedByFeatures: "Property enrichment, listing data, real estate adapter",
  },
  {
    key: "jina",
    name: "Jina AI",
    category: "ai",
    purpose: "Web content extraction for URL-based data sources",
    criticality: "standard",
    planName: "Pay-as-you-go",
    billingCycle: "usage",
    usageUnit: "requests",
    consoleUrl: "https://jina.ai/",
    usedByFeatures: "URL data source import, web scraping",
  },
];

export async function seedServices() {
  let created = 0;
  for (const svc of SEED_SERVICES) {
    const exists = await prisma.externalService.findUnique({ where: { key: svc.key } });
    if (!exists) {
      await prisma.externalService.create({ data: svc });
      created++;
    }
  }
  return { created, total: SEED_SERVICES.length };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function computePercent(usage, limit) {
  if (!usage || !limit || limit === 0) return null;
  return Math.round((usage / limit) * 10000) / 100; // two decimals
}

function deriveStatus(percentUsed, renewalDate) {
  if (percentUsed == null) return "healthy";
  if (percentUsed >= 95) return "critical";
  if (percentUsed >= 80) return "near_limit";
  if (percentUsed >= 60) return "watch";
  return "healthy";
}
