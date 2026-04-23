import { prisma } from "../../prisma.js";

// ── Testers ──────────────────────────────────────────────────────────────

export async function listTesters({ search, status, cohort, tag, priority, limit = 100 }) {
  const where = {};
  if (status) where.status = status;
  if (cohort) where.cohort = cohort;
  if (priority) where.priority = priority;
  if (tag) where.tags = { has: tag };
  if (search) {
    where.OR = [
      { email: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
      { userId: { equals: search } },
      { workspaceId: { equals: search } },
    ];
  }

  return prisma.betaTester.findMany({
    where,
    take: limit,
    orderBy: [{ priority: "asc" }, { joinedAt: "desc" }],
    include: {
      _count: { select: { feedback: true } },
    },
  });
}

export async function getTester(id) {
  return prisma.betaTester.findUnique({
    where: { id },
    include: {
      feedback: {
        orderBy: { createdAt: "desc" },
        take: 30,
      },
    },
  });
}

export async function getTesterWithContext(id) {
  const tester = await getTester(id);
  if (!tester) return null;

  // Enrich with workspace context if linked
  let workspaceContext = null;
  if (tester.workspaceId) {
    const client = await prisma.client.findUnique({
      where: { id: tester.workspaceId },
      select: {
        id: true,
        name: true,
        status: true,
        industryKey: true,
        createdAt: true,
        connections: {
          select: { channel: true, status: true },
        },
        techStackConnections: {
          select: { providerKey: true, connectionStatus: true },
        },
        _count: {
          select: { drafts: true },
        },
      },
    });

    if (client) {
      // Recent failures
      const recentFailures = await prisma.draft.count({
        where: { clientId: client.id, status: "FAILED", updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      });

      workspaceContext = {
        ...client,
        draftCount: client._count.drafts,
        recentFailures,
      };
    }
  }

  // Recent activity events
  const recentActivity = await prisma.activityEvent.findMany({
    where: { userId: tester.userId },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { id: true, eventType: true, title: true, description: true, createdAt: true },
  }).catch(() => []);

  return {
    ...tester,
    workspaceContext,
    recentActivity,
  };
}

export async function createTester(data) {
  return prisma.betaTester.create({ data });
}

export async function updateTester(id, data) {
  return prisma.betaTester.update({ where: { id }, data });
}

export async function deleteTester(id) {
  return prisma.betaTester.delete({ where: { id } });
}

// ── Feedback ─────────────────────────────────────────────────────────────

export async function listFeedback({ search, status, type, severity, needsFollowUp, testerId, limit = 50, cursor }) {
  const where = {};
  if (status) where.status = status;
  if (type) where.type = type;
  if (severity) where.severity = severity;
  if (needsFollowUp === "true") where.needsFollowUp = true;
  if (testerId) where.testerId = testerId;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { body: { contains: search, mode: "insensitive" } },
      { id: { equals: search } },
    ];
  }

  const items = await prisma.betaFeedback.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: [{ needsFollowUp: "desc" }, { createdAt: "desc" }],
    include: {
      tester: { select: { id: true, email: true, name: true, cohort: true, priority: true } },
    },
  });

  const hasMore = items.length > limit;
  return {
    items: hasMore ? items.slice(0, limit) : items,
    nextCursor: hasMore ? items[limit - 1].id : null,
  };
}

export async function getFeedback(id) {
  return prisma.betaFeedback.findUnique({
    where: { id },
    include: {
      tester: { select: { id: true, email: true, name: true, cohort: true, tags: true, priority: true } },
    },
  });
}

export async function createFeedback(data) {
  // Auto-link to tester if one exists for this userId
  let testerId = data.testerId || null;
  if (!testerId && data.userId) {
    const tester = await prisma.betaTester.findUnique({ where: { userId: data.userId } });
    if (tester) testerId = tester.id;
  }
  return prisma.betaFeedback.create({ data: { ...data, testerId } });
}

export async function updateFeedback(id, data) {
  // If resolving, set resolvedAt
  if (data.status === "resolved" || data.status === "wont_fix" || data.status === "duplicate") {
    data.resolvedAt = new Date();
  }
  return prisma.betaFeedback.update({ where: { id }, data });
}

export async function deleteFeedback(id) {
  return prisma.betaFeedback.delete({ where: { id } });
}

// ── Summary ──────────────────────────────────────────────────────────────

export async function getBetaSummary() {
  const [testers, feedback] = await Promise.all([
    prisma.betaTester.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
    prisma.betaFeedback.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
  ]);

  const needsFollowUp = await prisma.betaFeedback.count({ where: { needsFollowUp: true, status: { notIn: ["resolved", "wont_fix", "duplicate"] } } });
  const highPriorityTesters = await prisma.betaTester.count({ where: { priority: "high", status: "active" } });
  const totalTesters = await prisma.betaTester.count();
  const activeTesters = await prisma.betaTester.count({ where: { status: "active" } });

  const testersByStatus = Object.fromEntries(testers.map((t) => [t.status, t._count.id]));
  const feedbackByStatus = Object.fromEntries(feedback.map((f) => [f.status, f._count.id]));

  return {
    testers: { total: totalTesters, active: activeTesters, byStatus: testersByStatus, highPriority: highPriorityTesters },
    feedback: { byStatus: feedbackByStatus, needsFollowUp },
  };
}
