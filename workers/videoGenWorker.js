// BullMQ worker for Squadpitch AI video generation.
//
// Queue: "sp-video-gen", concurrency: 1 (video gen is slow + expensive).
//
// Job lifecycle on the asset row:
//   PENDING -> GENERATING -> READY    (url + publicId + thumbnailUrl populated)
//                         -> FAILED   (errorMessage set)

import { Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { prisma } from "../prisma.js";
import { submitGeneration } from "../lib/fal.js";
import { getVideoStorageService } from "../services/storage/imageStorage.js";
import { recordActivity } from "../domains/notifications/notification.service.js";

async function setStage(assetId, stage) {
  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: { progressStage: stage },
  });
}

async function processJob(assetId, aspectRatio) {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
  });
  if (!asset) throw new Error(`Video asset ${assetId} not found`);

  // Idempotency guard
  if (asset.status === "READY") {
    return { skipped: true, reason: "already-ready" };
  }

  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: { status: "GENERATING", progressStage: "Submitting" },
  });

  const started = Date.now();

  try {
    // 1. Build Fal input for video model
    const input = {
      prompt: asset.renderedPrompt,
      aspect_ratio: aspectRatio ?? "16:9",
      duration: "5",  // default 5s video
    };

    // 2. Call Fal.ai via queue mode (video gen takes minutes)
    await setStage(assetId, "Queued");
    const result = await submitGeneration({
      modelId: asset.falModelId,
      input,
      timeout: 300_000, // 5 minutes
      mode: "queue",
      onQueueUpdate: (update) => {
        if (update.status === "IN_QUEUE") {
          const pos = update.queue_position;
          setStage(assetId, pos != null ? `In Queue (position ${pos})` : "In Queue");
        } else if (update.status === "IN_PROGRESS") {
          setStage(assetId, "Generating");
        }
      },
    });

    const videoUrl = result.video?.url;
    if (!videoUrl) {
      throw new Error("Fal returned no video URL");
    }

    // 3. Download + rehost on Cloudinary (Fal CDN URLs expire)
    await setStage(assetId, "Downloading");
    const resp = await fetch(videoUrl);
    if (!resp.ok) {
      throw new Error(`Failed to download Fal video (${resp.status})`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    await setStage(assetId, "Uploading");
    const storage = getVideoStorageService();
    const uploaded = await storage.upload(buffer, {
      folder: `squadpitch/${asset.clientId}/generated`,
    });

    // 4. Mark asset READY
    const updated = await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        status: "READY",
        progressStage: null,
        url: uploaded.url,
        publicId: uploaded.publicId,
        width: uploaded.width,
        height: uploaded.height,
        bytes: uploaded.bytes,
        mimeType: uploaded.format ? `video/${uploaded.format}` : "video/mp4",
        thumbnailUrl: uploaded.thumbnailUrl,
        videoDurationSec: uploaded.durationSec,
        externalJobId: result.externalJobId ?? null,
        durationMs: Date.now() - started,
      },
    });

    // 5. If linked to a draft that has no mediaUrl, set it
    if (updated.draftId) {
      const draft = await prisma.draft.findUnique({
        where: { id: updated.draftId },
        select: { mediaUrl: true },
      });
      if (draft && !draft.mediaUrl) {
        await prisma.draft.update({
          where: { id: updated.draftId },
          data: { mediaUrl: updated.url, mediaType: "video" },
        });
      }
    }

    // 6. Record activity (resolve auth0Sub → userId)
    const creator = await prisma.user.findUnique({
      where: { auth0Sub: asset.createdBy },
      select: { id: true },
    });
    if (creator) {
      recordActivity({
        userId: creator.id,
        clientId: asset.clientId,
        eventType: "MEDIA_GENERATED",
        payload: { assetType: "video", clientId: asset.clientId },
        resourceType: "asset",
        resourceId: updated.id,
      }).catch(() => {});
    }

    return { assetId: updated.id };
  } catch (err) {
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        status: "FAILED",
        progressStage: null,
        errorMessage: err?.message ?? "Unknown error",
        durationMs: Date.now() - started,
      },
    });
    throw err;
  }
}

export function startVideoGenWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn(
      "[WORKER] No Redis connection — sp-video-gen worker disabled"
    );
    return null;
  }

  const worker = new Worker(
    "sp-video-gen",
    async (job) => processJob(job.data.assetId, job.data.aspectRatio),
    { connection, concurrency: 1 }
  );

  worker.on("completed", (job) => {
    console.log(`[WORKER] sp-video-gen job ${job.id} completed`);
  });
  worker.on("failed", (job, err) => {
    console.error(
      `[WORKER] sp-video-gen job ${job?.id} failed:`,
      err?.message ?? err
    );
  });
  worker.on("error", (err) => {
    console.error(
      "[WORKER] sp-video-gen worker error:",
      err?.message ?? err
    );
  });

  console.log("[WORKER] sp-video-gen worker started");
  return worker;
}
