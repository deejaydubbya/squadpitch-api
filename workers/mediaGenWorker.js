// BullMQ worker for Squadpitch AI media generation.
//
// Queue: "sp-media-gen", concurrency: 2.
//
// Job lifecycle on the asset row:
//   PENDING -> GENERATING -> READY    (url + publicId populated)
//                         -> FAILED   (errorMessage set)

import { Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { prisma } from "../prisma.js";
import { submitGeneration } from "../lib/fal.js";
import { getImageStorageService } from "../services/storage/imageStorage.js";
import { recordActivity } from "../domains/notifications/notification.service.js";

async function setStage(assetId, stage) {
  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: { progressStage: stage },
  });
}

async function processJob(assetId, overrides) {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
  });
  if (!asset) throw new Error(`Media asset ${assetId} not found`);

  // Idempotency guard — don't re-run a succeeded asset on retry.
  if (asset.status === "READY") {
    return { skipped: true, reason: "already-ready" };
  }

  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: { status: "GENERATING", progressStage: "Submitting" },
  });

  const started = Date.now();

  try {
    // 1. Build Fal input from asset snapshot + optional overrides.
    const input = {
      prompt: asset.renderedPrompt,
      image_size: {
        width: overrides?.width ?? 1024,
        height: overrides?.height ?? 1024,
      },
      num_inference_steps: overrides?.steps ?? 28,
      guidance_scale: overrides?.guidanceScale ?? 3.5,
      num_images: 1,
      enable_safety_checker: true,
    };

    if (asset.loraSnapshot) {
      input.loras = [
        { path: asset.loraSnapshot, scale: asset.loraScaleSnapshot ?? 1.0 },
      ];
    }

    if (overrides?.seed != null) {
      input.seed = overrides.seed;
    }

    // 2. Call Fal.ai.
    await setStage(assetId, "Generating");
    const result = await submitGeneration({
      modelId: asset.falModelId,
      input,
    });

    const firstImage = result.images?.[0];
    if (!firstImage?.url) {
      throw new Error("Fal returned no image URL");
    }

    // 3. Download + rehost on Cloudinary (Fal CDN URLs expire).
    await setStage(assetId, "Downloading");
    const resp = await fetch(firstImage.url);
    if (!resp.ok) {
      throw new Error(`Failed to download Fal image (${resp.status})`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    await setStage(assetId, "Uploading");
    const storage = getImageStorageService();
    const uploaded = await storage.upload(buffer, {
      folder: `squadpitch/${asset.clientId}/generated`,
    });

    // 4. Mark asset READY.
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
        mimeType: uploaded.format ? `image/${uploaded.format}` : null,
        seed: result.seed != null ? BigInt(result.seed) : null,
        externalJobId: result.externalJobId ?? null,
        durationMs: Date.now() - started,
      },
    });

    // 5. If linked to a draft that has no mediaUrl, set it.
    if (updated.draftId) {
      const draft = await prisma.draft.findUnique({
        where: { id: updated.draftId },
        select: { mediaUrl: true },
      });
      if (draft && !draft.mediaUrl) {
        await prisma.draft.update({
          where: { id: updated.draftId },
          data: { mediaUrl: updated.url },
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
        payload: { assetType: "image", clientId: asset.clientId },
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

export function startMediaGenWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn(
      "[WORKER] No Redis connection — sp-media-gen worker disabled"
    );
    return null;
  }

  const worker = new Worker(
    "sp-media-gen",
    async (job) => processJob(job.data.assetId, job.data.overrides),
    { connection, concurrency: 2 }
  );

  worker.on("completed", (job) => {
    console.log(`[WORKER] sp-media-gen job ${job.id} completed`);
  });
  worker.on("failed", (job, err) => {
    console.error(
      `[WORKER] sp-media-gen job ${job?.id} failed:`,
      err?.message ?? err
    );
  });
  worker.on("error", (err) => {
    console.error(
      "[WORKER] sp-media-gen worker error:",
      err?.message ?? err
    );
  });

  console.log("[WORKER] sp-media-gen worker started");
  return worker;
}
