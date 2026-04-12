// Media import service — browse & import files from Google Drive / Dropbox.
//
// Delegates to provider-specific listFiles / downloadFile, then uploads
// the downloaded buffer to Cloudinary and creates a MediaAsset record.

import { prisma } from "../../prisma.js";
import { getImageStorageService, getVideoStorageService } from "../../services/storage/imageStorage.js";
import * as driveProvider from "./providers/driveProvider.js";
import * as dropboxProvider from "./providers/dropboxProvider.js";

const providers = {
  google_drive: driveProvider,
  dropbox: dropboxProvider,
};

/**
 * List files from a connected integration.
 */
export async function listFiles(userId, integrationId, options = {}) {
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, userId, isActive: true },
  });
  if (!integration) throw Object.assign(new Error("Integration not found"), { status: 404 });

  const provider = providers[integration.type];
  if (!provider) throw Object.assign(new Error(`Unsupported provider: ${integration.type}`), { status: 400 });

  return provider.listFiles(integrationId, integration.config, options);
}

/**
 * Import a file from a connected integration into Squadpitch as a MediaAsset.
 *
 * @param {string} userId
 * @param {string} integrationId
 * @param {string} fileRef — file ID (Drive) or file path (Dropbox)
 * @param {string} clientId — which client to attach the asset to
 * @returns {object} The created MediaAsset
 */
export async function importFile(userId, integrationId, fileRef, clientId) {
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, userId, isActive: true },
  });
  if (!integration) throw Object.assign(new Error("Integration not found"), { status: 404 });

  const provider = providers[integration.type];
  if (!provider) throw Object.assign(new Error(`Unsupported provider: ${integration.type}`), { status: 400 });

  // Download from provider
  const { buffer, mimeType, filename } = await provider.downloadFile(
    integrationId,
    integration.config,
    fileRef
  );

  // Determine asset type
  const isVideo = mimeType.startsWith("video/");
  const isImage = mimeType.startsWith("image/");
  if (!isVideo && !isImage) {
    throw Object.assign(new Error(`Unsupported file type: ${mimeType}`), { status: 400 });
  }

  // Upload to Cloudinary
  let cloudResult;
  if (isVideo) {
    const svc = getVideoStorageService();
    cloudResult = await svc.upload(buffer, { folder: `squadpitch/imports/${clientId}` });
  } else {
    const svc = getImageStorageService();
    cloudResult = await svc.upload(buffer, { folder: `squadpitch/imports/${clientId}` });
  }

  // Create MediaAsset record
  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "IMPORTED",
      status: "READY",
      url: cloudResult.url,
      publicId: cloudResult.publicId,
      width: cloudResult.width ?? null,
      height: cloudResult.height ?? null,
      bytes: cloudResult.bytes ?? null,
      mimeType,
      assetType: isVideo ? "video" : "image",
      thumbnailUrl: cloudResult.thumbnailUrl ?? null,
      videoDurationSec: cloudResult.durationSec ?? null,
      filename,
      createdBy: userId,
    },
  });

  // Log the import
  try {
    await prisma.integrationLog.create({
      data: {
        integrationId,
        eventType: "FILE_IMPORTED",
        status: "success",
        responseData: { assetId: asset.id, filename, mimeType },
      },
    });
  } catch {
    // Best-effort logging
  }

  return asset;
}
