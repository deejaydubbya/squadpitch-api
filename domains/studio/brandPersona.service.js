// Brand Persona CRUD + training integration for Squadpitch.
//
// Follows the same one-to-one pattern used by BrandProfile / VoiceProfile /
// MediaProfile (clientId is both PK and FK).

import { prisma } from "../../prisma.js";
import crypto from "crypto";
import { submitTrainingJob } from "./falPersonaTraining.service.js";
import { getPersonaTrainingQueue } from "../../lib/queues.js";

// -- Constants ---------------------------------------------------------------

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const MIN_TRAINING_IMAGES = 12;

// -- Errors ------------------------------------------------------------------

function notFound() {
  return Object.assign(new Error("Brand persona not found"), {
    status: 404,
    code: "PERSONA_NOT_FOUND",
  });
}

function clientNotFound() {
  return Object.assign(new Error("Client not found"), {
    status: 404,
    code: "CLIENT_NOT_FOUND",
  });
}

function badRequest(message, code) {
  return Object.assign(new Error(message), {
    status: 400,
    code: code || "BAD_REQUEST",
  });
}

// -- CRUD --------------------------------------------------------------------

export async function getBrandPersona(clientId) {
  return prisma.brandPersona.findUnique({ where: { clientId } });
}

export async function upsertBrandPersona(clientId, data, updatedBy) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) throw clientNotFound();

  return prisma.brandPersona.upsert({
    where: { clientId },
    create: {
      clientId,
      userId: updatedBy ?? null,
      personaType: data.personaType ?? "AGENT",
      name: data.name ?? null,
      status: data.status ?? "DRAFT",
      visualStyle: data.visualStyle ?? null,
      usageSettings: data.usageSettings ?? {},
      styleProfile: data.styleProfile ?? undefined,
      updatedBy: updatedBy ?? null,
    },
    update: {
      personaType: data.personaType ?? undefined,
      name: data.name ?? undefined,
      status: data.status ?? undefined,
      visualStyle: data.visualStyle ?? undefined,
      usageSettings: data.usageSettings ?? undefined,
      styleProfile: data.styleProfile ?? undefined,
      updatedBy: updatedBy ?? null,
    },
  });
}

export async function deleteBrandPersona(clientId) {
  const existing = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!existing) throw notFound();

  return prisma.brandPersona.delete({ where: { clientId } });
}

// -- Training images ---------------------------------------------------------

/**
 * Validate an image before adding to training set.
 */
function validateTrainingImage(imageData) {
  if (imageData.mimeType && !ALLOWED_IMAGE_TYPES.has(imageData.mimeType)) {
    throw badRequest(
      `Invalid image type: ${imageData.mimeType}. Allowed: JPEG, PNG, WebP, HEIC`,
      "INVALID_IMAGE_TYPE"
    );
  }
  if (imageData.size && imageData.size > MAX_IMAGE_SIZE_BYTES) {
    throw badRequest(
      `Image too large (${Math.round(imageData.size / 1024 / 1024)}MB). Maximum: 20MB`,
      "IMAGE_TOO_LARGE"
    );
  }
}

export async function addTrainingImage(clientId, imageData, updatedBy) {
  const persona = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!persona) throw notFound();

  validateTrainingImage(imageData);

  const images = Array.isArray(persona.trainingImages)
    ? persona.trainingImages
    : [];

  const newImage = {
    id: crypto.randomUUID(),
    url: imageData.url,
    filename: imageData.filename ?? null,
    size: imageData.size ?? null,
    mimeType: imageData.mimeType ?? null,
    quality: "good", // placeholder — future: run quality analysis
    addedAt: new Date().toISOString(),
  };

  images.push(newImage);

  await prisma.brandPersona.update({
    where: { clientId },
    data: {
      trainingImages: images,
      imageCount: images.length,
      updatedBy: updatedBy ?? null,
    },
  });

  return newImage;
}

export async function removeTrainingImage(clientId, imageId, updatedBy) {
  const persona = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!persona) throw notFound();

  const images = Array.isArray(persona.trainingImages)
    ? persona.trainingImages
    : [];

  const filtered = images.filter((img) => img.id !== imageId);

  if (filtered.length === images.length) {
    throw Object.assign(new Error("Image not found"), {
      status: 404,
      code: "IMAGE_NOT_FOUND",
    });
  }

  return prisma.brandPersona.update({
    where: { clientId },
    data: {
      trainingImages: filtered,
      imageCount: filtered.length,
      updatedBy: updatedBy ?? null,
    },
  });
}

// -- Consent -----------------------------------------------------------------

export async function recordConsent(clientId, updatedBy) {
  const persona = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!persona) throw notFound();

  return prisma.brandPersona.update({
    where: { clientId },
    data: {
      consentAt: new Date(),
      updatedBy: updatedBy ?? null,
    },
  });
}

// -- Training ----------------------------------------------------------------

export async function startTraining(clientId, updatedBy) {
  const persona = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!persona) throw notFound();

  // Validate prerequisites
  if (!persona.consentAt) {
    throw badRequest("Consent is required before training", "CONSENT_REQUIRED");
  }

  const images = Array.isArray(persona.trainingImages)
    ? persona.trainingImages
    : [];

  if (images.length < MIN_TRAINING_IMAGES) {
    throw badRequest(
      `At least ${MIN_TRAINING_IMAGES} training images required (have ${images.length})`,
      "INSUFFICIENT_IMAGES"
    );
  }

  if (persona.status === "TRAINING" || persona.status === "QUEUED") {
    throw badRequest("Training is already in progress", "TRAINING_IN_PROGRESS");
  }

  // Generate a unique trigger phrase for this persona
  const triggerPhrase =
    persona.triggerPhrase || `sqp_${clientId.slice(0, 8)}`;

  // Collect image URLs for training
  const imageUrls = images.map((img) => img.url);

  // Submit training job to fal.ai
  const { requestId } = await submitTrainingJob({
    imageUrls,
    triggerWord: triggerPhrase,
    personaName: persona.name || "AI Brand Persona",
    personaType: persona.personaType,
  });

  // Update persona with training job info
  await prisma.brandPersona.update({
    where: { clientId },
    data: {
      status: "QUEUED",
      providerTrainingId: requestId,
      triggerPhrase,
      trainingProgress: 5,
      errorMessage: null,
      userId: updatedBy ?? persona.userId,
      updatedBy: updatedBy ?? null,
    },
  });

  // Enqueue the worker job to poll for completion
  const queue = getPersonaTrainingQueue();
  if (queue) {
    // Remove any previous failed/completed job with the same ID so BullMQ accepts the new one
    const existingJob = await queue.getJob(`persona-${clientId}`);
    if (existingJob) {
      try { await existingJob.remove(); } catch {}
    }
    await queue.add("train-persona", { clientId }, {
      jobId: `persona-${clientId}`,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  return { requestId, triggerPhrase };
}

// -- Preview generation (on-demand, post-training) ---------------------------

export async function requestPreviews(clientId, updatedBy) {
  const persona = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!persona) throw notFound();

  if (persona.status !== "COMPLETED") {
    throw badRequest(
      "Persona must be fully trained before generating previews",
      "NOT_TRAINED"
    );
  }

  if (!persona.providerModelId) {
    throw badRequest("No trained model available", "NO_MODEL");
  }

  // Import here to avoid circular deps at module load time
  const { generatePreviewImages, DEFAULT_PREVIEW_PROMPTS, BRAND_STYLE_PREVIEW_PROMPTS } = await import(
    "./falPersonaTraining.service.js"
  );
  const { getImageStorageService } = await import(
    "../../services/storage/imageStorage.js"
  );

  const triggerWord = persona.triggerPhrase || `sqp_${clientId.slice(0, 8)}`;

  const prompts = persona.personaType === 'BRAND_STYLE'
    ? BRAND_STYLE_PREVIEW_PROMPTS
    : DEFAULT_PREVIEW_PROMPTS;

  const rawPreviews = await generatePreviewImages({
    loraUrl: persona.providerModelId,
    triggerWord,
    prompts: prompts.slice(0, 5),
  });

  // Rehost on Cloudinary
  const storage = getImageStorageService();
  const previewImages = [];

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
      // Skip individual failures
    }
  }

  await prisma.brandPersona.update({
    where: { clientId },
    data: {
      previewImages,
      updatedBy: updatedBy ?? null,
    },
  });

  return previewImages;
}

// -- Persona frame generation (for Smart Video intro/outro) ------------------

const FRAME_PROMPTS = {
  intro:
    "{trigger}, professional marketing intro pose, welcoming expression, clean modern background, {visualStyle}, no text in image, no text overlays, no watermarks, no logos, AI-generated content",
  outro:
    "{trigger}, professional closing pose, friendly expression, clean background, contact-ready composition, {visualStyle}, no text in image, no text overlays, no watermarks, no logos, AI-generated content",
  thumbnail:
    "{trigger}, eye-catching video thumbnail, vibrant colors, professional setting, social media ready, {visualStyle}, no text in image, no text overlays, no watermarks, no logos, AI-generated content",
};

export async function generatePersonaFrames(clientId, frames) {
  const persona = await prisma.brandPersona.findUnique({
    where: { clientId },
  });
  if (!persona) throw notFound();

  if (persona.status !== "COMPLETED") {
    throw badRequest(
      "Persona must be fully trained before generating frames",
      "NOT_TRAINED"
    );
  }

  if (!persona.providerModelId) {
    throw badRequest("No trained model available", "NO_MODEL");
  }

  const triggerWord = persona.triggerPhrase || `sqp_${clientId.slice(0, 8)}`;
  const visualStyle = persona.visualStyle || "professional photo style";

  // Build prompts for each requested frame purpose
  const prompts = frames.map((f) =>
    FRAME_PROMPTS[f.purpose].replace("{visualStyle}", visualStyle)
  );

  const { generatePreviewImages } = await import(
    "./falPersonaTraining.service.js"
  );
  const { getImageStorageService } = await import(
    "../../services/storage/imageStorage.js"
  );

  const rawImages = await generatePreviewImages({
    loraUrl: persona.providerModelId,
    triggerWord,
    prompts,
  });

  // Rehost on Cloudinary
  const storage = getImageStorageService();
  const results = [];

  for (let i = 0; i < rawImages.length; i++) {
    const raw = rawImages[i];
    try {
      const resp = await fetch(raw.url);
      if (!resp.ok) {
        throw new Error(`Failed to fetch generated image: ${resp.status}`);
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const uploaded = await storage.upload(buffer, {
        folder: `squadpitch/${clientId}/persona-frames`,
      });
      results.push({
        purpose: frames[i].purpose,
        url: uploaded.url,
        width: uploaded.width,
        height: uploaded.height,
      });
    } catch (err) {
      console.error(
        `[PersonaFrames] Failed to process ${frames[i].purpose} frame:`,
        err.message
      );
      // Skip individual failures — caller handles partial results
    }
  }

  if (results.length === 0) {
    throw badRequest(
      "Failed to generate any persona frames",
      "FRAME_GENERATION_FAILED"
    );
  }

  return results;
}

// -- Formatter ---------------------------------------------------------------

export function formatBrandPersona(persona) {
  if (!persona) return null;
  return {
    clientId: persona.clientId,
    personaType: persona.personaType,
    name: persona.name,
    status: persona.status,
    trainingImages: persona.trainingImages,
    imageCount: persona.imageCount,
    visualStyle: persona.visualStyle,
    usageSettings: persona.usageSettings,
    styleProfile: persona.styleProfile ?? null,
    trainingProgress: persona.trainingProgress,
    previewImages: persona.previewImages,
    provider: persona.provider,
    providerModelId: persona.providerModelId ? true : false, // expose as boolean — don't leak raw URL
    triggerPhrase: persona.triggerPhrase,
    errorMessage: persona.errorMessage,
    consentAt: persona.consentAt,
    updatedBy: persona.updatedBy,
    createdAt: persona.createdAt,
    updatedAt: persona.updatedAt,
  };
}
