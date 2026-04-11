// Thin facade re-exporting the Squadpitch studio domain services.
// Route handlers import from here so internal reorganizations don't churn
// route code.

export {
  listClients,
  getClient,
  createClient,
  updateClient,
  archiveClient,
  getBrandProfile,
  upsertBrandProfile,
  getVoiceProfile,
  upsertVoiceProfile,
  getMediaProfile,
  upsertMediaProfile,
  listChannelSettings,
  upsertChannelSettings,
  formatClient,
  formatBrandProfile,
  formatVoiceProfile,
  formatMediaProfile,
  formatChannelSettings,
} from "./client.service.js";

export {
  listDrafts,
  getDraft,
  updateDraft,
  deleteDraft,
  deleteDraftsByClient,
  duplicateDraft,
  formatDraft,
} from "./draft.service.js";

export {
  approveDraft,
  rejectDraft,
  scheduleDraft,
  transitionDraft,
  VALID_TRANSITIONS,
} from "./draftWorkflow.service.js";

// publishDraft is served by the publishing service (channel adapters
// + local fallback), not the workflow primitive.
export { publishDraft } from "./publishing/publishingService.js";

// Note: getConnectionForAdapter is intentionally NOT re-exported. It returns
// DECRYPTED tokens and must only be called from publishingService (which
// imports directly from ./connection.service.js). Keeping it off the facade
// prevents a route handler from accidentally leaking plaintext credentials.
export {
  listConnections,
  getConnection,
  upsertConnection,
  deleteConnection,
  updateConnectionStatus,
  checkAndUpdateExpiredConnections,
  validateConnection,
  formatConnection,
} from "./connection.service.js";

export { getClientAnalytics } from "./analytics.service.js";

export { generateDraft } from "./generation/aiGenerationService.js";
export { generateContentIdeas } from "./generation/ideasService.js";

export {
  listAssets,
  getAsset,
  uploadAsset,
  uploadVideoAsset,
  deleteAsset,
  attachAssetToDraft,
  detachAssetFromDraft,
  enqueueGeneration,
  formatAsset,
} from "./mediaGeneration.service.js";

export { enqueueVideoGeneration } from "./videoGeneration.service.js";

export {
  getMetrics,
  getClientMetricsSummary,
  syncMetrics,
  formatMetrics,
} from "./postMetrics.service.js";
