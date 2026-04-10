// Loads a Content Studio client + all profile sub-tables and produces
// the normalized GenerationContext consumed by promptBuilder + the
// aiGenerationService. Keeps the "load client with everything" query
// in one place so route handlers / services don't reimplement it.

import { prisma } from "../../../prisma.js";

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

  return {
    client,
    brand: client.brandProfile ?? null,
    voice: client.voiceProfile ?? null,
    media: client.mediaProfile ?? null,
    channelSettings: client.channelSettings ?? [],
    contentBuckets,
  };
}
