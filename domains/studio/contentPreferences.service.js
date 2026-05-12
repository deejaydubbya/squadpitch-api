// Content Preferences CRUD.
//
// Persistent per-workspace defaults the Squadpitch assistant uses
// when no in-session choice has been made. Mirrors the one-to-one
// pattern of BrandProfile / VoiceProfile / MediaProfile / BrandPersona
// (clientId is both PK and FK to Client).
//
// The assistant consumer (squadpitch-web lib/assistant/contentPreferences.ts)
// reads these via the matching /workspaces/:id/content-preferences
// route, which is registered in studio.routes.js.

import { prisma } from "../../prisma.js";

// Defaults returned when no preferences row exists for a workspace.
// Picked to match what the assistant already treats as the safe
// fallback when the persistent layer returns null. Keep this in
// sync with lib/assistant/contentPreferences.ts resolveDefaults().
const EMPTY_PREFERENCES = {
  preferredChannels: [],
  defaultQuickPostChannel: null,
  preferredTone: null,
  preferredCtaStyle: null,
  preferredCampaignCadence: null,
  defaultCampaignType: null,
  mediaOrderPreference: null,
  defaultContentBucket: null,
  alwaysRequireReview: true,
  autoGenerateMedia: false,
};

function shape(row, clientId) {
  if (!row) {
    return {
      clientId,
      ...EMPTY_PREFERENCES,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    clientId: row.clientId,
    preferredChannels: row.preferredChannels ?? [],
    defaultQuickPostChannel: row.defaultQuickPostChannel ?? null,
    preferredTone: row.preferredTone ?? null,
    preferredCtaStyle: row.preferredCtaStyle ?? null,
    preferredCampaignCadence: row.preferredCampaignCadence ?? null,
    defaultCampaignType: row.defaultCampaignType ?? null,
    mediaOrderPreference: row.mediaOrderPreference ?? null,
    defaultContentBucket: row.defaultContentBucket ?? null,
    alwaysRequireReview: row.alwaysRequireReview,
    autoGenerateMedia: row.autoGenerateMedia,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getContentPreferences(clientId) {
  const row = await prisma.contentPreferences.findUnique({
    where: { clientId },
  });
  return shape(row, clientId);
}

/**
 * Upsert. Only fields explicitly present in `patch` are written;
 * `undefined` keys are ignored so a partial update (just toggling
 * autoGenerateMedia, say) leaves everything else intact.
 *
 * The caller is expected to have already validated the payload via
 * ContentPreferencesUpdateSchema in studio.schemas.js.
 */
export async function updateContentPreferences(clientId, patch) {
  const data = {};
  for (const key of [
    "preferredChannels",
    "defaultQuickPostChannel",
    "preferredTone",
    "preferredCtaStyle",
    "preferredCampaignCadence",
    "defaultCampaignType",
    "mediaOrderPreference",
    "defaultContentBucket",
    "alwaysRequireReview",
    "autoGenerateMedia",
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      data[key] = patch[key];
    }
  }

  const row = await prisma.contentPreferences.upsert({
    where: { clientId },
    update: data,
    create: { clientId, ...data },
  });
  return shape(row, clientId);
}
