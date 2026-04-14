// Loads a Content Studio client + all profile sub-tables and produces
// the normalized GenerationContext consumed by promptBuilder + the
// aiGenerationService. Keeps the "load client with everything" query
// in one place so route handlers / services don't reimplement it.
//
// Redis cache: generation contexts are cached for 30 minutes to avoid
// redundant DB reads when users generate multiple posts in a session.

import { prisma } from "../../../prisma.js";
import { redisGet, redisSet, redisDel } from "../../../redis.js";
import { getContentContext } from "../../industry/industry.service.js";
import { buildTechStackContentContext } from "../../industry/techStack.service.js";

const CACHE_TTL = 1800; // 30 minutes
const CACHE_PREFIX = "sp:client:ctx:";

/**
 * Load a Content Studio client with all profiles and channel settings.
 * Throws a structured error if missing, archived, or paused.
 *
 * @param {string} clientId
 * @returns {Promise<{
 *   client: object,
 *   brand: object | null,
 *   voice: object | null,
 *   media: object | null,
 *   channelSettings: object[],
 *   contentBuckets: Array<{ key: string, label: string, template: string }>,
 * }>}
 */
export async function loadClientGenerationContext(clientId) {
  // Try Redis cache first
  const cacheKey = `${CACHE_PREFIX}${clientId}`;
  const cached = await redisGet(cacheKey);
  if (cached) {
    try {
      const ctx = JSON.parse(cached);
      // Validate cached client status
      if (ctx.client?.status === "ARCHIVED" || ctx.client?.status === "PAUSED") {
        await redisDel(cacheKey);
      } else {
        return ctx;
      }
    } catch {
      // Corrupted cache — fall through to DB
    }
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      brandProfile: true,
      voiceProfile: true,
      mediaProfile: true,
      channelSettings: true,
    },
  });

  if (!client) {
    throw Object.assign(new Error("Client not found"), {
      status: 404,
      code: "CLIENT_NOT_FOUND",
    });
  }

  if (client.status === "ARCHIVED") {
    throw Object.assign(new Error("Client is archived"), {
      status: 404,
      code: "CLIENT_ARCHIVED",
    });
  }

  if (client.status === "PAUSED") {
    throw Object.assign(new Error("Client is paused"), {
      status: 423,
      code: "CLIENT_PAUSED",
    });
  }

  const contentBuckets = Array.isArray(client.voiceProfile?.contentBuckets)
    ? client.voiceProfile.contentBuckets
    : [];

  const industryContext = getContentContext(client.industryKey);

  // Load connected tech stack context (website, channels, etc.)
  let techStackContext = null;
  try {
    techStackContext = await buildTechStackContentContext(clientId);
  } catch {
    // Non-critical — generation works without tech stack context
  }

  const ctx = {
    client,
    industryKey: client.industryKey ?? null,
    industryContext,
    techStackContext,
    brand: client.brandProfile ?? null,
    voice: client.voiceProfile ?? null,
    media: client.mediaProfile ?? null,
    channelSettings: client.channelSettings ?? [],
    contentBuckets,
  };

  // Cache for next request (fire-and-forget)
  redisSet(cacheKey, JSON.stringify(ctx), CACHE_TTL).catch(() => {});

  return ctx;
}

/**
 * Invalidate the cached generation context for a client.
 * Call this after updating brand/voice/media profiles or channel settings.
 */
export async function invalidateClientContext(clientId) {
  await redisDel(`${CACHE_PREFIX}${clientId}`);
}
