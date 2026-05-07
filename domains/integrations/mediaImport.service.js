// Media import service — browse & import files from Google Drive / Dropbox.
//
// Delegates to provider-specific listFiles / downloadFile, then uploads
// the downloaded buffer to Cloudinary and creates a MediaAsset record.

import { prisma } from "../../prisma.js";
import { getImageStorageService, getVideoStorageService } from "../../services/storage/imageStorage.js";
import { enforceUsageLimit, incrementUsage, checkStorageLimit } from "../billing/billing.service.js";
import { sniffImageMime, sniffVideoMime } from "../../lib/mimeDetect.js";
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
  const { buffer, mimeType: providerMime, filename } = await provider.downloadFile(
    integrationId,
    integration.config,
    fileRef
  );

  // MIME safety: sniff the actual bytes rather than trust the provider's
  // declared mimeType. We allowlist only formats our publishing channels
  // support.
  const sniffedImage = sniffImageMime(buffer);
  const sniffedVideo = sniffVideoMime(buffer);
  if (!sniffedImage && !sniffedVideo) {
    const err = new Error(
      `Unsupported file type. Allowed: JPEG, PNG, WebP, GIF, MP4, MOV, WebM.`
    );
    err.status = 415;
    err.code = "UNSUPPORTED_MEDIA_TYPE";
    throw err;
  }
  const mimeType = sniffedImage ?? sniffedVideo;
  const isVideo = Boolean(sniffedVideo);
  // Drop providerMime intentionally — recorded MIME is always the sniffed one.
  void providerMime;

  // Enforce usage & storage limits before uploading
  const usageField = isVideo ? "videos" : "images";
  const quotaErr = await enforceUsageLimit(userId, usageField);
  if (quotaErr) {
    const err = new Error(`Monthly ${usageField} limit reached. Upgrade your plan for more.`);
    err.status = 402;
    err.code = isVideo ? "VIDEO_LIMIT_EXCEEDED" : "IMAGE_LIMIT_EXCEEDED";
    throw err;
  }
  const storageCheck = await checkStorageLimit(userId, buffer.length, isVideo);
  if (!storageCheck.allowed) {
    const err = new Error(storageCheck.reason);
    err.status = 402;
    err.code = "STORAGE_LIMIT";
    throw err;
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

  await incrementUsage(userId, usageField);

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

/**
 * Export a MediaAsset to a connected cloud provider (Google Drive / Dropbox).
 *
 * @param {string} userId
 * @param {string} integrationId
 * @param {string} assetId — MediaAsset id
 * @param {string} [folderRef] — optional target folder (Drive folder ID or Dropbox path)
 * @returns {object} Provider-specific upload result
 */
export async function exportFile(userId, integrationId, assetId, folderRef) {
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, userId, isActive: true },
  });
  if (!integration) throw Object.assign(new Error("Integration not found"), { status: 404 });

  const provider = providers[integration.type];
  if (!provider?.uploadFile) {
    throw Object.assign(new Error(`Provider ${integration.type} does not support export`), { status: 400 });
  }

  // Tenant isolation: only export assets that live in a workspace
  // owned by the requesting user. Without this, anyone with a connected
  // Drive could call export with another user's MediaAsset id and have
  // its bytes copied into their own cloud storage. Client.createdBy
  // stores the auth0 sub (no FK relation to User), so we resolve the
  // sub once and filter via the relation.
  const requester = await prisma.user.findUnique({
    where: { id: userId },
    select: { auth0Sub: true },
  });
  if (!requester) throw Object.assign(new Error("Asset not found"), { status: 404 });
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: assetId, client: { createdBy: requester.auth0Sub } },
  });
  if (!asset) throw Object.assign(new Error("Asset not found"), { status: 404 });
  if (!asset.url) throw Object.assign(new Error("Asset has no URL"), { status: 400 });

  // Download asset from Cloudinary URL
  const dlRes = await fetch(asset.url, { signal: AbortSignal.timeout(60_000) });
  if (!dlRes.ok) {
    throw Object.assign(new Error(`Failed to download asset (${dlRes.status})`), { status: 502 });
  }
  const arrayBuf = await dlRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  const filename = asset.filename || `asset-${asset.id}.${asset.mimeType?.split("/")[1] || "png"}`;
  const mimeType = asset.mimeType || "application/octet-stream";

  // Upload to provider
  const result = await provider.uploadFile(
    integrationId,
    integration.config,
    buffer,
    filename,
    mimeType,
    folderRef
  );

  // Log the export
  try {
    await prisma.integrationLog.create({
      data: {
        integrationId,
        eventType: "FILE_EXPORTED",
        status: "success",
        responseData: { assetId, filename, provider: integration.type, result },
      },
    });
  } catch {
    // Best-effort logging
  }

  return result;
}
