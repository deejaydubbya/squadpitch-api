// BullMQ worker for AI Brand Persona training (fal.ai LoRA).
//
// Queue: "sp-persona-training", concurrency: 1 (training is slow + expensive).
//
// Job lifecycle on the persona row:
//   QUEUED -> TRAINING -> COMPLETED  (providerModelId populated)
//                      -> FAILED     (errorMessage set)
//
// The worker polls fal.ai for training status since LoRA training is
// long-running (typically 5–15 minutes).

import { Worker } from "bullmq";
import { getRedisConnection } from "../redis.js";
import { CONSERVATIVE_WORKER_OPTIONS } from "../lib/bullmqOptions.js";
import { prisma } from "../prisma.js";
import {
  checkTrainingStatus,
  generatePreviewImages,
  DEFAULT_PREVIEW_PROMPTS,
} from "../domains/studio/falPersonaTraining.service.js";
import { getImageStorageService } from "../services/storage/imageStorage.js";
import { recordServiceSuccess, recordServiceFailure } from "../domains/billing/serviceHealth.service.js";
import { recordActivity } from "../domains/notifications/notification.service.js";

const POLL_INTERVAL_MS = 10_000; // 10s between status checks
const MAX_POLL_ATTEMPTS = 180;   // 30 minutes max (180 * 10s)

async function processJob(clientId) {
  const persona = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!persona) throw new Error(`Brand persona not found for client ${clientId}`);

  // Idempotency guard
  if (persona.status === "COMPLETED") {
    return { skipped: true, reason: "already-completed" };
  }

  if (!persona.providerTrainingId) {
    throw new Error("No providerTrainingId — training was not submitted");
  }

  // Mark as TRAINING
  await prisma.brandPersona.update({
    where: { clientId },
    data: { status: "TRAINING", trainingProgress: 10 },
  });

  const started = Date.now();

  try {
    // Poll for training completion
    let attempts = 0;
    let trainingResult = null;

    while (attempts < MAX_POLL_ATTEMPTS) {
      const status = await checkTrainingStatus(persona.providerTrainingId);

      if (status.status === "COMPLETED") {
        trainingResult = status.result;
        break;
      }

      if (status.status === "FAILED") {
        throw new Error(status.error || "Training failed on provider side");
      }

      // Update progress
      await prisma.brandPersona.update({
        where: { clientId },
        data: { trainingProgress: status.progress ?? 50 },
      });

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      attempts++;
    }

    if (!trainingResult) {
      throw new Error("Training timed out after 30 minutes");
    }

    if (!trainingResult.loraUrl) {
      throw new Error("Training completed but no model URL returned");
    }

    recordServiceSuccess("fal").catch(() => {});

    // Update persona with provider model reference
    await prisma.brandPersona.update({
      where: { clientId },
      data: {
        trainingProgress: 85,
        providerModelId: trainingResult.loraUrl,
      },
    });

    // Generate preview images using the trained model
    const triggerWord = persona.triggerPhrase || `sqp_${clientId.slice(0, 8)}`;
    let previewImages = [];

    try {
      const rawPreviews = await generatePreviewImages({
        loraUrl: trainingResult.loraUrl,
        triggerWord,
        prompts: DEFAULT_PREVIEW_PROMPTS.slice(0, 5),
      });

      // Rehost preview images on Cloudinary (fal CDN URLs expire)
      const storage = getImageStorageService();
      for (const preview of rawPreviews) {
        try {
          const resp = await fetch(preview.url);
          if (!resp.ok) continue;
          const buffer = Buffer.from(await resp.arrayBuffer());
          const uploaded = await storage.upload(buffer, {
            folder: `squadpitch/${clientId}/persona-previews`,
          });
          previewImages.push({
            url: uploaded.url,
            publicId: uploaded.publicId,
            prompt: preview.prompt,
            width: uploaded.width,
            height: uploaded.height,
          });
        } catch {
          // Skip individual preview failures — don't fail the whole job
        }
      }
    } catch (previewErr) {
      // Preview generation is best-effort — training still succeeded
      console.warn(`[PERSONA] Preview generation failed for ${clientId}:`, previewErr.message);
    }

    // Mark COMPLETED
    await prisma.brandPersona.update({
      where: { clientId },
      data: {
        status: "COMPLETED",
        trainingProgress: 100,
        previewImages: previewImages.length > 0 ? previewImages : null,
        errorMessage: null,
      },
    });

    // Record activity
    if (persona.userId) {
      const user = await prisma.user.findUnique({
        where: { auth0Sub: persona.userId },
        select: { id: true },
      });
      if (user) {
        recordActivity({
          userId: user.id,
          clientId,
          eventType: "PERSONA_TRAINING_COMPLETED",
          payload: { personaName: persona.name, previewCount: previewImages.length },
          resourceType: "persona",
          resourceId: clientId,
        }).catch(() => {});
      }
    }

    return {
      clientId,
      previewCount: previewImages.length,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    recordServiceFailure("fal").catch(() => {});
    await prisma.brandPersona.update({
      where: { clientId },
      data: {
        status: "FAILED",
        trainingProgress: 0,
        errorMessage: err?.message ?? "Unknown training error",
      },
    });

    // Record training failure activity
    if (persona.userId) {
      const user = await prisma.user.findUnique({
        where: { auth0Sub: persona.userId },
        select: { id: true },
      }).catch(() => null);
      if (user) {
        recordActivity({
          userId: user.id,
          clientId,
          eventType: "PERSONA_TRAINING_FAILED",
          payload: { personaName: persona.name, error: (err?.message ?? "Unknown error").slice(0, 200) },
          resourceType: "persona",
          resourceId: clientId,
        }).catch(() => {});
      }
    }

    throw err;
  }
}

export function startPersonaTrainingWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[WORKER] No Redis — personaTrainingWorker disabled");
    return null;
  }

  const worker = new Worker(
    "sp-persona-training",
    async (job) => {
      const { clientId } = job.data;
      return processJob(clientId);
    },
    {
      connection,
      concurrency: 1,
      ...CONSERVATIVE_WORKER_OPTIONS,
      limiter: { max: 1, duration: 60_000 }, // max 1 training per minute
    }
  );

  worker.on("completed", (job) => {
    console.log(`[PERSONA] Training completed: ${job.data.clientId}`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[PERSONA] Training failed: ${job?.data?.clientId}`, err?.message);
  });

  console.log("[WORKER] personaTrainingWorker started (concurrency: 1)");
  return worker;
}
