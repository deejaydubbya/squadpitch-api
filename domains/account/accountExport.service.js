import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import { prisma } from "../../prisma.js";

export const EXPORT_SCHEMA_VERSION = "squadpitch-account-export.v1";
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_KEY = /(password|secret|token|authorization|cookie|webhookUrl|checkoutUrl|paymentMethod|card|apiKey|credential|privateKey)/i;

export function sanitizeExport(value) {
  if (Array.isArray(value)) return value.map(sanitizeExport);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, child]) => [key, sanitizeExport(child)]));
}

export async function collectAccountExport({ user, prismaClient = prisma }) {
  const workspaces = await prismaClient.client.findMany({
    where: { createdBy: user.auth0Sub },
    include: {
      brandProfile: true, voiceProfile: true, mediaProfile: true,
      brandPersona: true, contentPreferences: true,
      campaigns: true, drafts: true,
      mediaAssets: true, contacts: true,
      conversations: { include: { messages: true, notes: true, aiReplies: true } },
      site: { include: { pages: true, forms: { include: { submissions: true } } } },
      dataSources: true, dataItems: true,
      connections: { select: { id: true, channel: true, displayName: true, scopes: true, status: true, tokenExpiresAt: true, lastValidatedAt: true, createdAt: true, updatedAt: true } },
      techStackConnections: { select: { id: true, providerKey: true, connectionStatus: true, connectedAt: true, createdAt: true, updatedAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const workspaceIds = workspaces.map(({ id }) => id);
  const [subscription, usage, activity, integrations, aiUsage, audit] = await Promise.all([
    prismaClient.subscription.findUnique({ where: { userId: user.id }, select: { stripeCustomerId: true, stripeSubscriptionId: true, tier: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, createdAt: true, updatedAt: true } }),
    prismaClient.usageRecord.findMany({ where: { userId: user.id }, orderBy: { periodStart: "asc" } }),
    prismaClient.activityEvent.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    prismaClient.integration.findMany({ where: { userId: user.id }, select: { id: true, type: true, name: true, isActive: true, createdAt: true, updatedAt: true } }),
    prismaClient.aiUsageLog.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    prismaClient.auditLog.findMany({ where: { actorSub: user.auth0Sub }, select: { action: true, resourceType: true, resourceId: true, route: true, metadata: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return sanitizeExport({
    account: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt },
    workspaces, billing: subscription, usage, activity, integrations, aiUsage, audit,
    metadata: { workspaceCount: workspaceIds.length },
  });
}

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2));
}

export async function createExportArchive({ user, generatedAt = new Date(), prismaClient = prisma }) {
  const data = await collectAccountExport({ user, prismaClient });
  const sections = Object.entries(data).map(([name, value]) => ({ name, file: `${name}.json`, body: jsonBuffer(value) }));
  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + EXPORT_TTL_MS).toISOString(),
    sections: sections.map(({ name, file, body }) => ({ name, file, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") })),
  };
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const stream = new PassThrough();
  const chunks = [];
  stream.on("data", chunk => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); archive.on("error", reject); });
  archive.pipe(stream);
  archive.append(jsonBuffer(manifest), { name: "manifest.json" });
  for (const section of sections) archive.append(section.body, { name: section.file });
  await archive.finalize();
  await complete;
  const buffer = Buffer.concat(chunks);
  if (buffer.length > 100 * 1024 * 1024) throw Object.assign(new Error("Export exceeds the supported archive size"), { status: 413, code: "EXPORT_TOO_LARGE" });
  return { buffer, manifest };
}

export async function prepareExportDownload({ requestId, user, now = new Date(), prismaClient = prisma }) {
  const request = await prismaClient.accountLifecycleRequest.findFirst({ where: { id: requestId, userId: user.id, type: "EXPORT_ACCOUNT" } });
  if (!request) throw Object.assign(new Error("Export request not found"), { status: 404, code: "EXPORT_NOT_FOUND" });
  if (request.exportExpiresAt && request.exportExpiresAt <= now) throw Object.assign(new Error("Export has expired"), { status: 410, code: "EXPORT_EXPIRED" });
  const result = await createExportArchive({ user, generatedAt: now, prismaClient });
  const exportExpiresAt = request.exportExpiresAt ?? new Date(now.getTime() + EXPORT_TTL_MS);
  await prismaClient.accountLifecycleRequest.update({ where: { id: request.id }, data: { status: "COMPLETED", completedAt: now, exportExpiresAt } });
  return { ...result, exportExpiresAt };
}
