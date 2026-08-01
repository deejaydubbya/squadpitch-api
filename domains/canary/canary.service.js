import { Queue, Worker } from "bullmq";
import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { getRedisConnection } from "../../redis.js";
import { getUsage } from "../billing/billing.service.js";
import { runProductionAiVerification } from "../aiPlatform/productionVerification.service.js";
import { integrationCapabilityMatrix } from "../integrations/integrationCapabilityMatrix.js";
import { summarizeCanaryResults } from "./canaryPolicy.js";

const ROLLBACK = Symbol("canary-rollback");

export async function runProductionCanary({
  workspaceId,
  userId,
  runId,
  requestId,
  fetchImpl = globalThis.fetch,
}) {
  const results = [];
  const workspace = await prisma.client.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, status: true },
  });
  results.push(
    result(
      "auth.workspace-access",
      Boolean(workspace),
      "Normal workspace ownership middleware admitted the synthetic identity.",
    ),
  );

  results.push(await databaseRollbackProbe({ workspaceId, runId }));

  try {
    const usage = await getUsage(userId);
    results.push(
      result(
        "billing.status-lookup",
        Boolean(usage?.tier),
        "Billing entitlement read completed without checkout or charge.",
      ),
    );
  } catch {
    results.push(
      result(
        "billing.status-lookup",
        false,
        "Billing entitlement lookup failed.",
      ),
    );
  }

  try {
    const ai = await runProductionAiVerification({
      workspaceId,
      requestTraceId: requestId,
    });
    results.push(...summarizeAiCanaryResults(ai.results, requestId));
  } catch {
    results.push(
      result(
        "ai.provenance-present",
        false,
        "AI service provenance was unavailable.",
      ),
    );
    results.push(
      result("ai.hosted-provenance", false, "Hosted AI dry-run failed."),
    );
    results.push(
      result(
        "ai.trace-correlation",
        false,
        "Node and hosted AI trace correlation was unavailable.",
      ),
    );
    results.push({
      id: "ai.fallback-status",
      status: "WARN",
      message:
        "Fallback status unavailable because hosted verification failed.",
    });
  }

  results.push(await queueRoundTripProbe(runId));
  results.push(await sitesHealthProbe(fetchImpl));
  results.push(providerConfigurationResult());
  results.push({
    id: "media.generation",
    status: env.PRODUCTION_CANARY_MEDIA_ENABLED ? "WARN" : "WARN",
    message: env.PRODUCTION_CANARY_MEDIA_ENABLED
      ? "Media canary flag is enabled, but generation requires an operator-approved paid-media implementation; no generation was attempted."
      : "Media generation is disabled; no paid provider call was attempted.",
  });
  results.push({
    id: "publishing.boundary",
    status: "PASS",
    message:
      "No publish adapter was invoked. Publishing requires a separately configured canary destination and operator action.",
  });

  return {
    schemaVersion: "production-canary.v1",
    synthetic: true,
    runId,
    workspaceId,
    generatedAt: new Date().toISOString(),
    summary: summarizeCanaryResults(results),
    results,
  };
}

export function summarizeAiCanaryResults(aiResults, requestId) {
  const operations = Array.isArray(aiResults) ? aiResults : [];
  const failed = operations.filter((item) => !item.usableResult).length;
  const provenancePresent =
    operations.length > 0 && operations.every((item) => item.provenance);
  const hosted = operations.filter(
    (item) => item.provenance?.source === "squadpitch-ai",
  ).length;
  const traceCorrelated =
    operations.length > 0 &&
    operations.every(
      (item) =>
        typeof item.provenance?.traceId === "string" &&
        item.provenance.traceId.startsWith(`${requestId}:`),
    );
  const fallback = operations.filter(
    (item) => item.provenance?.fallbackUsed,
  ).length;
  const results = [];
  results.push(
    result(
      "ai.provenance-present",
      provenancePresent,
      provenancePresent
        ? `${operations.length} AI operation(s) returned service provenance.`
        : "AI service provenance was missing.",
    ),
  );
  results.push(
    result(
      "ai.hosted-provenance",
      failed === 0 && provenancePresent && hosted > 0,
      failed > 0
        ? `${failed} hosted AI verification operation(s) returned unusable output.`
        : hosted > 0
          ? `${hosted}/${operations.length} AI dry-run operation(s) returned hosted Squadpitch AI output; remaining operations truthfully reported their execution mode.`
          : "Usable AI output was not verified as hosted Squadpitch AI.",
    ),
  );
  results.push(
    result(
      "ai.trace-correlation",
      traceCorrelated,
      traceCorrelated
        ? "Node and hosted AI provenance trace identifiers were correlated."
        : "Node and hosted AI trace correlation failed.",
    ),
  );
  results.push({
    id: "ai.fallback-status",
    status: fallback ? "WARN" : "PASS",
    message: fallback
      ? `${fallback} AI operation(s) reported fallback.`
      : "No AI fallback reported.",
  });
  return results;
}

async function databaseRollbackProbe({ workspaceId, runId }) {
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.workspaceDataSource.create({
        data: {
          clientId: workspaceId,
          type: "MANUAL",
          name: `[SYNTHETIC CANARY] ${runId}`,
          config: { synthetic: true, runId },
        },
        select: { id: true, name: true },
      });
      const read = await tx.workspaceDataSource.findUnique({
        where: { id: row.id },
        select: { name: true },
      });
      if (read?.name !== row.name) throw new Error("canary read mismatch");
      throw ROLLBACK;
    });
  } catch (error) {
    if (error === ROLLBACK) {
      return result(
        "database.rollback-write",
        true,
        "Synthetic write/read succeeded and was transactionally rolled back.",
      );
    }
  }
  return result(
    "database.rollback-write",
    false,
    "Synthetic transactional write/read/rollback failed.",
  );
}

async function queueRoundTripProbe(runId) {
  const producer = getRedisConnection();
  const consumer = getRedisConnection();
  if (!producer || !consumer) {
    await closeRedis(producer);
    await closeRedis(consumer);
    return result(
      "queue.round-trip",
      false,
      "Redis connection is unavailable.",
    );
  }
  const queueName = "sp-production-canary";
  const jobId = `canary-${runId.replaceAll(":", "_")}`;
  const queue = new Queue(queueName, { connection: producer });
  let worker;
  try {
    const consumed = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("queue timeout")),
        10_000,
      );
      worker = new Worker(queueName, async (job) => job.data.runId, {
        connection: consumer,
      });
      worker.on("completed", (job, value) => {
        if (job.id === jobId && value === runId) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
      worker.on("failed", (_job, error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    await queue.add(
      "synthetic-round-trip",
      { synthetic: true, runId },
      {
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    await consumed;
    return result(
      "queue.round-trip",
      true,
      "Dedicated synthetic queue job was enqueued, consumed, and removed.",
    );
  } catch {
    return result(
      "queue.round-trip",
      false,
      "Dedicated synthetic queue round trip failed.",
    );
  } finally {
    await worker?.close().catch(() => {});
    await queue.close().catch(() => {});
    await closeRedis(producer);
    await closeRedis(consumer);
  }
}

async function sitesHealthProbe(fetchImpl) {
  if (!env.PRODUCTION_CANARY_SITES_HEALTH_URL) {
    return {
      id: "sites.runtime",
      status: "WARN",
      message: "Sites health URL is not configured.",
    };
  }
  try {
    const response = await fetchImpl(env.PRODUCTION_CANARY_SITES_HEALTH_URL, {
      signal: AbortSignal.timeout(8_000),
    });
    return result(
      "sites.runtime",
      response.ok,
      `Sites runtime returned HTTP ${response.status}.`,
    );
  } catch {
    return result(
      "sites.runtime",
      false,
      "Sites runtime health request failed.",
    );
  }
}

function providerConfigurationResult() {
  const providers = Object.keys(integrationCapabilityMatrix);
  const configured = providers.filter((provider) =>
    providerConfigPresent(provider),
  );
  return {
    id: "providers.configuration",
    status: configured.length ? "PASS" : "WARN",
    message: `${configured.length}/${providers.length} integration entries have detectable credential configuration; no OAuth or provider action was attempted.`,
  };
}

function providerConfigPresent(provider) {
  const prefixes = {
    FACEBOOK: "META",
    INSTAGRAM: "INSTAGRAM",
    LINKEDIN: "LINKEDIN",
    LINKEDIN_ORGANIZATION_PAGE: "LINKEDIN",
    THREADS: "THREADS",
    YOUTUBE: "YOUTUBE",
    GOOGLE_BUSINESS_PROFILE: "GOOGLE_BUSINESS",
    TIKTOK: "TIKTOK",
    PINTEREST: "PINTEREST",
    X: "X",
    REDDIT: "REDDIT",
  };
  const prefix = prefixes[provider];
  return Boolean(
    prefix &&
    Object.entries(process.env).some(
      ([key, value]) => key.startsWith(`${prefix}_`) && value,
    ),
  );
}

function result(id, pass, message) {
  return { id, status: pass ? "PASS" : "FAIL", message };
}

async function closeRedis(connection) {
  if (connection) await connection.quit().catch(() => {});
}
