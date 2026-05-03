// fal.ai LoRA training service for AI Brand Personas.
//
// Isolates all fal.ai provider-specific logic for persona training.
// The rest of the codebase refers to "AI Brand Persona" — this module
// is the only place that knows about LoRA internals.

import { fal } from "@fal-ai/client";
import archiver from "archiver";
import { PassThrough } from "stream";
import { env } from "../../config/env.js";

// fal.ai LoRA training model (flux LoRA trainer)
const FAL_LORA_TRAINING_MODEL = "fal-ai/flux-lora-fast-training";
// fal.ai LoRA inference model
const FAL_LORA_INFERENCE_MODEL = "fal-ai/flux-lora";

// Training timeout: 30 minutes (LoRA training can be long)
const TRAINING_TIMEOUT_MS = 30 * 60 * 1000;
// Preview generation timeout
const PREVIEW_TIMEOUT_MS = 120_000;

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!env.FAL_API_KEY) {
    throw Object.assign(
      new Error("FAL_API_KEY is not set — persona training disabled"),
      { status: 500, code: "FAL_NOT_CONFIGURED" }
    );
  }
  fal.config({ credentials: env.FAL_API_KEY });
  configured = true;
}

/**
 * Download images and bundle them into an in-memory zip buffer.
 */
async function createTrainingZip(imageUrls) {
  return new Promise(async (resolve, reject) => {
    const chunks = [];
    const passthrough = new PassThrough();
    passthrough.on("data", (chunk) => chunks.push(chunk));
    passthrough.on("end", () => resolve(Buffer.concat(chunks)));
    passthrough.on("error", reject);

    const archive = archiver("zip", { zlib: { level: 1 } }); // fast compression
    archive.on("error", reject);
    archive.pipe(passthrough);

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const ext = url.match(/\.(jpe?g|png|webp|heic)(\?|$)/i)?.[1] || "jpg";
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        archive.append(buf, { name: `image_${String(i).padStart(3, "0")}.${ext}` });
      } catch {
        // Skip individual download failures
      }
    }

    archive.finalize();
  });
}

/**
 * Submit a LoRA training job to fal.ai.
 *
 * @param {{ imageUrls: string[], triggerWord: string, personaName: string, personaType?: string }} params
 * @returns {Promise<{ requestId: string }>} — the fal queue request ID to poll
 */
export async function submitTrainingJob({ imageUrls, triggerWord, personaName, personaType }) {
  ensureConfigured();

  // Bundle images into a zip and upload to fal storage
  const zipBuffer = await createTrainingZip(imageUrls);
  if (zipBuffer.length === 0) {
    throw new Error("Failed to create training zip — no images downloaded");
  }

  const zipBlob = new Blob([zipBuffer], { type: "application/zip" });
  const zipFile = new File([zipBlob], "training-images.zip", { type: "application/zip" });
  const imagesDataUrl = await fal.storage.upload(zipFile);

  const isBrandStyle = personaType === "BRAND_STYLE";

  const input = {
    images_data_url: imagesDataUrl,
    trigger_word: triggerWord,
    steps: isBrandStyle ? 1200 : 1000,
    is_style: isBrandStyle,
    create_masks: !isBrandStyle,
  };

  // Use fal.queue.submit for long-running training — we poll separately.
  const { request_id } = await fal.queue.submit(FAL_LORA_TRAINING_MODEL, {
    input,
  });

  return { requestId: request_id };
}

/**
 * Check the status of a fal.ai training job.
 *
 * @param {string} requestId — fal queue request ID
 * @returns {Promise<{ status: 'IN_QUEUE'|'IN_PROGRESS'|'COMPLETED'|'FAILED', progress?: number, result?: object }>}
 */
export async function checkTrainingStatus(requestId) {
  ensureConfigured();

  const status = await fal.queue.status(FAL_LORA_TRAINING_MODEL, {
    requestId,
    logs: false,
  });

  // Normalize fal status to our internal representation
  if (status.status === "COMPLETED") {
    // Fetch the result
    const result = await fal.queue.result(FAL_LORA_TRAINING_MODEL, {
      requestId,
    });

    return {
      status: "COMPLETED",
      progress: 100,
      result: {
        loraUrl: result.data?.diffusers_lora_file?.url ?? null,
        configUrl: result.data?.config_file?.url ?? null,
      },
    };
  }

  if (status.status === "FAILED") {
    return {
      status: "FAILED",
      progress: 0,
      error: status.error ?? "Training failed",
    };
  }

  // IN_QUEUE or IN_PROGRESS
  // fal doesn't give granular progress, so we estimate based on queue position
  const progress = status.status === "IN_PROGRESS"
    ? Math.min(70, 30 + (status.queue_position != null ? 0 : 20))
    : 10; // IN_QUEUE
  return {
    status: status.status,
    progress,
  };
}

/**
 * Generate preview images using a trained persona LoRA.
 *
 * @param {{ loraUrl: string, triggerWord: string, prompts: string[] }} params
 * @returns {Promise<Array<{ url: string, prompt: string }>>}
 */
export async function generatePreviewImages({ loraUrl, triggerWord, prompts }) {
  ensureConfigured();

  const results = [];

  for (const prompt of prompts) {
    const fullPrompt = prompt.replace("{trigger}", triggerWord);

    const result = await fal.run(FAL_LORA_INFERENCE_MODEL, {
      input: {
        prompt: fullPrompt,
        image_size: { width: 1024, height: 1024 },
        num_inference_steps: 28,
        guidance_scale: 3.5,
        num_images: 1,
        enable_safety_checker: true,
        loras: [{ path: loraUrl, scale: 1.0 }],
      },
    });

    const imageUrl = result?.data?.images?.[0]?.url;
    if (imageUrl) {
      results.push({ url: imageUrl, prompt: fullPrompt });
    }
  }

  return results;
}

/**
 * Default preview prompts for persona training.
 * Uses {trigger} placeholder for the trigger word.
 */
export const DEFAULT_PREVIEW_PROMPTS = [
  "A professional headshot of {trigger}, clean background, confident expression, studio lighting",
  "A social media marketing photo of {trigger}, modern office setting, approachable and friendly",
  "{trigger} presenting a real estate listing, professional attire, warm smile, luxury home in background",
  "An educational-style photo of {trigger} explaining a concept, whiteboard behind, professional setting",
  "A thumbnail-style close-up of {trigger}, vibrant background, energetic expression, social media ready",
];

export const BRAND_STYLE_PREVIEW_PROMPTS = [
  "A social media marketing graphic {trigger}, modern design, professional layout",
  "An educational infographic {trigger}, clean typography, informative",
  "A real estate listing flyer {trigger}, property showcase, elegant design",
  "A market update graphic {trigger}, data visualization, professional",
  "A video thumbnail {trigger}, bold text area, eye-catching composition",
];
