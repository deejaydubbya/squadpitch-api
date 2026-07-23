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
import { fal } from "@fal-ai/client";
import { getImageStorageService } from "../services/storage/imageStorage.js";
import { recordActivity } from "../domains/notifications/notification.service.js";
import { recordServiceSuccess, recordServiceFailure } from "../domains/billing/serviceHealth.service.js";
import sharp from "sharp";

async function setStage(assetId, stage) {
  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: { progressStage: stage },
  });
}

// ── Image loading helper ──────────────────────────────────────────────
// Accepts URL, data URL, or Buffer. Validates, fetches, and normalizes
// to a PNG buffer that sharp can always process.

async function loadImageBuffer(input, label = "image") {
  let buf;

  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === "string") {
    if (input.startsWith("data:")) {
      // Data URL: data:image/png;base64,iVBOR...
      const match = input.match(/^data:image\/[^;]+;base64,(.+)$/);
      if (!match) throw new Error(`Could not parse data URL for ${label}`);
      buf = Buffer.from(match[1], "base64");
    } else {
      // HTTP(S) URL
      const resp = await fetch(input);
      if (!resp.ok) {
        throw new Error(`Could not load ${label} (HTTP ${resp.status})`);
      }
      const ct = resp.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) {
        throw new Error(`Could not load ${label} for compositing — server returned ${ct || "unknown type"} instead of an image`);
      }
      buf = Buffer.from(await resp.arrayBuffer());
    }
  } else {
    throw new Error(`Invalid input type for ${label}: ${typeof input}`);
  }

  if (!buf || buf.length === 0) {
    throw new Error(`Empty buffer for ${label}`);
  }

  // Normalize to sRGB PNG — handles JPEG, WebP, AVIF, TIFF, applies EXIF rotation,
  // and forces sRGB colorspace to prevent grayscale/unexpected color output.
  try {
    buf = await sharp(buf).rotate().toColourspace("srgb").png().toBuffer();
  } catch (e) {
    throw new Error(`Unsupported image format for ${label}. Please use JPG, PNG, or WebP.`);
  }

  const meta = await sharp(buf).metadata();
  console.log(`[COMPOSITE] loadImageBuffer(${label}): ${meta.width}x${meta.height}, ${meta.channels}ch, space=${meta.space}`);

  return buf;
}

// ── Compositing pipeline ──────────────────────────────────────────────

async function removeBackground(imageUrl) {
  const result = await fal.run("fal-ai/birefnet", {
    input: { image_url: imageUrl },
  });
  const outputUrl = result?.data?.image?.url;
  if (!outputUrl) throw new Error("Background removal returned no image");
  return outputUrl;
}

// ── Pixel-level cutout transparency validation ────────────────────────
// Metadata `.hasAlpha` only tells us if the image HAS an alpha channel,
// not if any pixels are actually transparent.  An image can be RGBA with
// alpha = 255 everywhere (opaque black background).  This function samples
// corners + borders and reports real transparency stats.

async function validateCutoutTransparency(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width;
  const h = meta.height;
  const channels = meta.channels || 3;

  // If no alpha channel at all, fast fail
  if (channels < 4 || !meta.hasAlpha) {
    console.log(`[TRANSPARENCY] FAIL — no alpha channel (channels=${channels})`);
    return { hasTransparency: false, transparentPixelRatio: 0, cornerAlphas: [], reason: "no_alpha_channel" };
  }

  // Extract raw RGBA pixel data from a downscaled version (fast)
  const sampleSize = Math.min(200, Math.min(w, h));
  const raw = await sharp(buffer)
    .resize(sampleSize, sampleSize, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const sw = sampleSize;
  const sh = sampleSize;

  // Sample 4 corners (5x5 pixel blocks)
  const cornerSize = 5;
  const corners = [
    { label: "top-left",     x: 0,                y: 0 },
    { label: "top-right",    x: sw - cornerSize,  y: 0 },
    { label: "bottom-left",  x: 0,                y: sh - cornerSize },
    { label: "bottom-right", x: sw - cornerSize,  y: sh - cornerSize },
  ];

  const cornerAlphas = [];
  let transparentCorners = 0;

  for (const corner of corners) {
    let alphaSum = 0;
    let pixelCount = 0;
    for (let dy = 0; dy < cornerSize; dy++) {
      for (let dx = 0; dx < cornerSize; dx++) {
        const px = corner.x + dx;
        const py = corner.y + dy;
        const idx = (py * sw + px) * 4;
        alphaSum += raw[idx + 3];
        pixelCount++;
      }
    }
    const avgAlpha = alphaSum / pixelCount;
    cornerAlphas.push({ label: corner.label, avgAlpha: Math.round(avgAlpha) });
    if (avgAlpha < 128) transparentCorners++;
  }

  // Sample border pixels (top + bottom rows, left + right columns)
  let borderTransparent = 0;
  let borderTotal = 0;
  // Top row
  for (let x = 0; x < sw; x++) {
    if (raw[(0 * sw + x) * 4 + 3] < 128) borderTransparent++;
    borderTotal++;
  }
  // Bottom row
  for (let x = 0; x < sw; x++) {
    if (raw[((sh - 1) * sw + x) * 4 + 3] < 128) borderTransparent++;
    borderTotal++;
  }
  // Left column
  for (let y = 1; y < sh - 1; y++) {
    if (raw[(y * sw + 0) * 4 + 3] < 128) borderTransparent++;
    borderTotal++;
  }
  // Right column
  for (let y = 1; y < sh - 1; y++) {
    if (raw[(y * sw + (sw - 1)) * 4 + 3] < 128) borderTransparent++;
    borderTotal++;
  }

  // Count all transparent pixels in the image
  let totalTransparent = 0;
  const totalPixels = sw * sh;
  for (let i = 0; i < totalPixels; i++) {
    if (raw[i * 4 + 3] < 250) totalTransparent++;
  }

  const transparentPixelRatio = totalTransparent / totalPixels;
  const borderTransparentRatio = borderTotal > 0 ? borderTransparent / borderTotal : 0;

  // A valid cutout should have:
  // - At least 2 transparent corners (background corners)
  // - At least 30% of border pixels transparent
  // - At least 10% of total pixels transparent (person takes up some but not all)
  const hasTransparency = transparentCorners >= 2 && borderTransparentRatio > 0.3 && transparentPixelRatio > 0.05;

  const reason = hasTransparency ? "ok" : (
    transparentCorners < 2 ? "opaque_corners" :
    borderTransparentRatio <= 0.3 ? "opaque_borders" : "insufficient_transparent_pixels"
  );

  console.log(`[TRANSPARENCY] corners: ${transparentCorners}/4 transparent, border: ${(borderTransparentRatio * 100).toFixed(1)}%, total: ${(transparentPixelRatio * 100).toFixed(1)}% → ${hasTransparency ? "PASS" : "FAIL"} (${reason})`);
  console.log(`[TRANSPARENCY] Corner alphas: ${cornerAlphas.map(c => `${c.label}=${c.avgAlpha}`).join(", ")}`);

  return { hasTransparency, transparentPixelRatio, borderTransparentRatio, transparentCorners, cornerAlphas, reason };
}

// ── Full-body validation ────────────────────────────────────────────
// Checks that the bottom 15% of the generated image contains persona
// content (feet/legs) rather than empty white background.

async function checkFullBody(imageUrl) {
  try {
    const buf = await loadImageBuffer(imageUrl, "full-body check");
    const meta = await sharp(buf).metadata();
    const h = meta.height;
    const w = meta.width;

    const sliceH = Math.max(1, Math.round(h * 0.15));
    const sliceTop = h - sliceH;
    const bottomStats = await sharp(buf)
      .extract({ left: 0, top: sliceTop, width: w, height: sliceH })
      .stats();

    // Low std dev + very bright = empty white background (no feet)
    const avgStdDev =
      (bottomStats.channels[0].stdev + bottomStats.channels[1].stdev + bottomStats.channels[2].stdev) / 3;
    const avgBright =
      (bottomStats.channels[0].mean + bottomStats.channels[1].mean + bottomStats.channels[2].mean) / 3;

    const hasContent = avgStdDev > 10 || avgBright < 240;
    console.log(`[COMPOSITE] Full-body check: stdDev=${avgStdDev.toFixed(1)}, brightness=${avgBright.toFixed(1)}, hasContent=${hasContent}`);
    return hasContent;
  } catch (e) {
    console.warn("[COMPOSITE] Full-body check failed, assuming valid:", e.message);
    return true; // Don't block on validation errors
  }
}

// ── Scene analysis ──────────────────────────────────────────────────
// Detects interior vs exterior, color temperature, contrast, and
// brightness to drive dynamic scaling and color matching.

async function analyzeScene(baseBuffer) {
  const meta = await sharp(baseBuffer).metadata();
  const w = meta.width;
  const h = meta.height;

  const stats = await sharp(baseBuffer).stats();
  const rMean = stats.channels[0].mean;
  const gMean = stats.channels[1].mean;
  const bMean = stats.channels[2].mean;
  const avgBrightness = (rMean + gMean + bMean) / 3;

  // Top 20% — sky detection
  const topH = Math.max(1, Math.round(h * 0.2));
  const topStats = await sharp(baseBuffer)
    .extract({ left: 0, top: 0, width: w, height: topH })
    .stats();
  const topBrightness =
    (topStats.channels[0].mean + topStats.channels[1].mean + topStats.channels[2].mean) / 3;
  const topBlueDominance =
    topStats.channels[2].mean - (topStats.channels[0].mean + topStats.channels[1].mean) / 2;

  // Bottom 30% — floor region
  const floorTop = Math.round(h * 0.7);
  const floorH = Math.max(1, h - floorTop);
  const bottomStats = await sharp(baseBuffer)
    .extract({ left: 0, top: floorTop, width: w, height: floorH })
    .stats();
  const bottomBrightness =
    (bottomStats.channels[0].mean + bottomStats.channels[1].mean + bottomStats.channels[2].mean) / 3;

  // Interior vs exterior heuristic
  const hasSky = topBrightness > 160 && topBlueDominance > 10;
  const brightTop = topBrightness > avgBrightness * 1.3;
  const isInterior = !(hasSky || brightTop);

  // Color temperature: positive = warm, negative = cool
  const warmth = avgBrightness > 0 ? (rMean - bMean) / avgBrightness : 0;

  // Scene contrast (average std deviation across channels)
  const contrast =
    (stats.channels[0].stdev + stats.channels[1].stdev + stats.channels[2].stdev) / 3;

  return { isInterior, avgBrightness, warmth, contrast, bottomBrightness, width: w, height: h };
}

// ── Placement intelligence ──────────────────────────────────────────
// Analyzes bottom 40% of the image in vertical strips to find the most
// uniform region (likely open floor), avoiding furniture and windows.

async function findOpenFloorPosition(baseBuffer, scene, pW) {
  const { width: w, height: h } = scene;
  const floorTop = Math.round(h * 0.6);
  const floorH = Math.max(1, h - floorTop);
  const numStrips = 5;
  const stripW = Math.max(1, Math.round(w / numStrips));

  let bestStrip = 3; // default right-of-center
  let bestScore = Infinity;

  for (let i = 0; i < numStrips; i++) {
    const stripLeft = i * stripW;
    const extractW = Math.min(stripW, w - stripLeft);
    if (extractW <= 0) continue;

    try {
      const ss = await sharp(baseBuffer)
        .extract({ left: stripLeft, top: floorTop, width: extractW, height: floorH })
        .stats();
      // Low std dev = uniform area = likely open floor
      const uniformity =
        (ss.channels[0].stdev + ss.channels[1].stdev + ss.channels[2].stdev) / 3;
      // Penalize strips far from floor average brightness (furniture / windows)
      const stripBright =
        (ss.channels[0].mean + ss.channels[1].mean + ss.channels[2].mean) / 3;
      const brightnessPenalty = Math.abs(stripBright - scene.bottomBrightness) * 0.5;
      const score = uniformity + brightnessPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestStrip = i;
      }
    } catch {
      // Skip strip on error
    }
  }

  const stripCenter = bestStrip * stripW + stripW / 2;
  return Math.max(0, Math.min(Math.round(stripCenter - pW / 2), w - pW));
}

// ── Foot detection ──────────────────────────────────────────────────
// Scans the alpha channel from the bottom up to find the lowest row
// with non-transparent pixels (the actual feet). Returns the offset
// from the image bottom to the real foot position.

async function detectFootPosition(pngBuffer) {
  const meta = await sharp(pngBuffer).metadata();
  if (meta.channels !== 4) return { footRow: meta.height, paddingBelow: 0 };

  const { data, info } = await sharp(pngBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const alphaThreshold = 153; // 0.6 * 255 — ignore faint/anti-aliased pixels
  const minDensity = 0.02;   // at least 2% of row must be solid

  // Scan rows bottom-up, looking for rows with solid foot contact
  let lowestOpaqueRow = 0;
  for (let row = h - 1; row >= 0; row--) {
    let solidPixels = 0;
    for (let col = 0; col < w; col++) {
      if (data[(row * w + col) * 4 + 3] > alphaThreshold) {
        solidPixels++;
      }
    }
    const density = solidPixels / w;
    if (density > minDensity) {
      lowestOpaqueRow = row;
      break;
    }
  }

  const paddingBelow = h - 1 - lowestOpaqueRow;
  console.log(`[COMPOSITE] Foot detection: lowestOpaqueRow=${lowestOpaqueRow}/${h}, paddingBelow=${paddingBelow}px`);
  return { footRow: lowestOpaqueRow, paddingBelow };
}

// ── Compositing pipeline ────────────────────────────────────────────

async function compositeImages(baseBuffer, personaBuffer, placement, personaLayer = null) {
  // ── 0. Analyze scene ──────────────────────────────────────────────
  const scene = await analyzeScene(baseBuffer);
  const { width: baseW, height: baseH, isInterior } = scene;

  // ── PersonaLayer path: user-defined layer transform ────────────────
  if (personaLayer) {
    const layerScale = personaLayer.scale ?? 0.38;
    const layerCenterX = personaLayer.centerX ?? 0.5;
    const layerFootY = personaLayer.footY ?? 0.92;
    const framingPreset = personaLayer.framingPreset ?? 'full_body';

    console.log(`[COMPOSITE] PersonaLayer: centerX=${layerCenterX}, footY=${layerFootY}, scale=${layerScale}, framing=${framingPreset}`);

    // Resize persona to target height (scale × baseH)
    const targetH = Math.round(baseH * layerScale);
    let personaProcessed = await sharp(personaBuffer)
      .resize({ height: Math.max(50, targetH), fit: "inside" })
      .png()
      .toBuffer();

    let pMeta = await sharp(personaProcessed).metadata();
    let pW = pMeta.width;
    let pH = pMeta.height;

    // Detect foot position in persona cutout
    const { paddingBelow } = await detectFootPosition(personaProcessed);

    // Place persona so actual feet (not image bottom) align at footY
    const footPixelY = Math.round(layerFootY * baseH);
    let top = footPixelY - pH + paddingBelow;
    let left = Math.round(layerCenterX * baseW - pW / 2);

    top = Math.round(top);
    console.log(`[COMPOSITE] PersonaLayer placement: footPixelY=${footPixelY}, top=${top}, left=${left}, persona=${pW}x${pH}, paddingBelow=${paddingBelow}`);
    console.log(`[COMPOSITE] PersonaLayer formula: renderedH=${targetH}, footYInSubject=${pH - paddingBelow}, x=${left}, y=${top}`);

    // DO NOT auto-fit — allow overflow, parts outside canvas are clipped
    // But we do need to handle sharp composite constraints:
    // sharp requires left >= 0 and top >= 0 for composite layers,
    // so we crop the persona buffer if it extends outside the canvas.

    let cropLeft = 0, cropTop = 0, cropRight = 0, cropBottom = 0;
    if (left < 0) { cropLeft = -left; left = 0; }
    if (top < 0) { cropTop = -top; top = 0; }
    if (left + pW > baseW) { cropRight = (left + pW) - baseW; }
    if (top + pH > baseH) { cropBottom = (top + pH) - baseH; }

    const visibleW = pW - cropLeft - cropRight;
    const visibleH = pH - cropTop - cropBottom;

    if (visibleW <= 0 || visibleH <= 0) {
      console.log(`[COMPOSITE] PersonaLayer: persona entirely outside canvas, skipping`);
      return await sharp(baseBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    // Crop persona to visible region if any overflow
    if (cropLeft > 0 || cropTop > 0 || cropRight > 0 || cropBottom > 0) {
      console.log(`[COMPOSITE] Cropping persona for overflow: L=${cropLeft} T=${cropTop} R=${cropRight} B=${cropBottom}`);
      personaProcessed = await sharp(personaProcessed)
        .extract({ left: cropLeft, top: cropTop, width: visibleW, height: visibleH })
        .png()
        .toBuffer();
      pW = visibleW;
      pH = visibleH;
    }

    // Edge feathering (alpha only)
    const hasMeta = await sharp(personaProcessed).metadata();
    if (hasMeta.channels === 4) {
      const rgbBuf = await sharp(personaProcessed).removeAlpha().sharpen({ sigma: 0.3 }).toColourspace("srgb").png().toBuffer();
      const alphaBuf = await sharp(personaProcessed).extractChannel(3).blur(0.5).png().toBuffer();
      personaProcessed = await sharp(rgbBuf).joinChannel(alphaBuf).png().toBuffer();
    }

    // Color matching
    const personaBrightness = 150;
    const brightnessFactor = scene.avgBrightness / personaBrightness;
    const iBright = Math.max(0.65, Math.min(1.35, brightnessFactor)) * 0.97;
    const iSat = (scene.contrast < 40 ? 0.9 : 1.0) * 1.04;
    // Extract alpha before modulate (modulate strips alpha, ensureAlpha would create opaque alpha=255)
    const alphaPreMod1 = await sharp(personaProcessed).extractChannel(3).png().toBuffer();
    personaProcessed = await sharp(personaProcessed).removeAlpha()
      .modulate({ brightness: iBright, saturation: iSat })
      .toColourspace("srgb").png().toBuffer();
    personaProcessed = await sharp(personaProcessed).joinChannel(alphaPreMod1).png().toBuffer();

    // Contrast boost (+7%)
    {
      const cMeta = await sharp(personaProcessed).metadata();
      const ch = cMeta.channels || 3;
      const cA = ch === 4 ? [1.07, 1.07, 1.07, 1] : [1.07, 1.07, 1.07];
      const cB = ch === 4 ? [-9, -9, -9, 0] : [-9, -9, -9];
      personaProcessed = await sharp(personaProcessed).linear(cA, cB).png().toBuffer();
    }

    // Warmth shift
    if (Math.abs(scene.warmth) > 0.05) {
      const shift = Math.max(-0.08, Math.min(0.08, scene.warmth * 0.4));
      const curMeta = await sharp(personaProcessed).metadata();
      const ch = curMeta.channels || 3;
      const aArr = ch === 4 ? [1 + shift, 1, 1 - shift, 1] : [1 + shift, 1, 1 - shift];
      const bArr = ch === 4 ? [0, 0, 0, 0] : [0, 0, 0];
      personaProcessed = await sharp(personaProcessed).linear(aArr, bArr).png().toBuffer();
    }

    // Shadow — only if feet are visible on canvas
    const layers = [];
    const actualFootOnCanvas = top + pH; // after any top cropping
    const feetVisible = layerFootY <= 1.02; // feet within or near canvas bottom

    if (feetVisible && actualFootOnCanvas > 0 && actualFootOnCanvas <= baseH) {
      const shadowY = Math.min(actualFootOnCanvas, baseH);

      // Soft shadow
      try {
        const softW = Math.round(pW * 1.0);
        const softH = Math.max(8, Math.round(pH * 0.12));
        const softSvg = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${softW}" height="${softH}"><ellipse cx="${Math.round(softW / 2)}" cy="${Math.round(softH / 2)}" rx="${Math.round(softW * 0.45)}" ry="${Math.round(softH * 0.4)}" fill="black" opacity="0.15"/></svg>`
        );
        const softPng = await sharp(softSvg).png().blur(15).toBuffer();
        const sLeft = Math.round(left + pW / 2 - softW / 2);
        const sTop = shadowY - Math.round(softH * 0.3);
        if (sLeft >= 0 && sTop >= 0 && sLeft + softW <= baseW && sTop + softH <= baseH) {
          layers.push({ input: softPng, left: sLeft, top: sTop, blend: "over" });
        }
      } catch { }

      // Contact shadow — directly under feet
      try {
        const conW = Math.round(pW * 0.5);
        const conH = Math.max(4, Math.round(pH * 0.03));
        const conSvg = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${conW}" height="${conH}"><ellipse cx="${Math.round(conW / 2)}" cy="${Math.round(conH / 2)}" rx="${Math.round(conW * 0.45)}" ry="${Math.round(conH * 0.45)}" fill="black" opacity="0.30"/></svg>`
        );
        const conPng = await sharp(conSvg).png().blur(3).toBuffer();
        const cLeft = Math.round(left + pW / 2 - conW / 2);
        const cTop = shadowY - Math.round(conH * 0.5);
        if (cLeft >= 0 && cTop >= 0 && cLeft + conW <= baseW && cTop + conH <= baseH) {
          layers.push({ input: conPng, left: cLeft, top: cTop, blend: "over" });
        }
      } catch { }
    }

    layers.push({ input: personaProcessed, left, top, blend: "over" });

    // Verify foot grounding (full_body only)
    if (framingPreset === 'full_body' && feetVisible) {
      const verifyFootY = top + pH - (cropBottom > 0 ? 0 : paddingBelow);
      const diff = Math.abs(verifyFootY - footPixelY);
      console.log(`[COMPOSITE] Foot verification: actualFootY=${verifyFootY}, targetFootY=${footPixelY}, diff=${diff}px`);
    }

    console.log(`[COMPOSITE] PersonaLayer result:`, JSON.stringify({
      baseImageSize: `${baseW}x${baseH}`,
      personaLayer: { centerX: layerCenterX, footY: layerFootY, scale: layerScale, framingPreset },
      renderedPersonSize: `${pW}x${pH}`,
      footYInSubject: pH - (cropBottom > 0 ? 0 : paddingBelow),
      finalXY: `(${left}, ${top})`,
      feetVisible,
      overflow: { cropLeft, cropTop, cropRight, cropBottom },
    }));
    return await sharp(baseBuffer).composite(layers).jpeg({ quality: 92 }).toBuffer();
  }

  // ── Auto path (no personaLayer) ────────────────────────────────────

  // ── 1. Scaling — fixed 42% ──────────────────────────────────────
  let targetH = Math.round(baseH * 0.42);

  let personaProcessed = await sharp(personaBuffer)
    .resize({ height: targetH, fit: "inside" })
    .png()
    .toBuffer();

  let personaMeta = await sharp(personaProcessed).metadata();
  let pW = personaMeta.width;
  let pH = personaMeta.height;

  // ── Safe margins ──────────────────────────────────────────────────
  const hMargin = Math.round(baseW * 0.05);   // 5% horizontal
  const bMargin = Math.round(baseH * 0.04);   // 4% bottom
  const tMargin = Math.round(baseH * 0.02);   // 2% top

  // ── 2. Detect actual foot position in persona image ────────────────
  const { paddingBelow } = await detectFootPosition(personaProcessed);

  // Ground line: auto-detected from scene type
  const groundLineY = Math.round(baseH * (isInterior ? 0.90 : 0.92));
  const maxFootY = baseH - bMargin;
  const footY = Math.min(groundLineY, maxFootY);

  // Place so actual feet (not image bottom) align with ground line
  // top + pH - paddingBelow = footY  →  top = footY - pH + paddingBelow
  let top = footY - pH + paddingBelow;

  // If persona too tall: scale down to fit between top margin and foot
  if (top < tMargin) {
    const availableH = footY - tMargin;
    if (availableH > 50) {
      personaProcessed = await sharp(personaBuffer)
        .resize({ height: availableH, fit: "inside" })
        .png()
        .toBuffer();
      personaMeta = await sharp(personaProcessed).metadata();
      pW = personaMeta.width;
      pH = personaMeta.height;
      top = footY - pH;
    }
  }

  // Final vertical safety: full body must never be clipped
  top = Math.max(0, top);
  if (top + pH > baseH) {
    top = baseH - pH;
    if (top < 0) {
      // Persona taller than canvas — scale to fit with margins
      const safeH = baseH - tMargin - bMargin;
      personaProcessed = await sharp(personaBuffer)
        .resize({ height: Math.max(50, safeH), fit: "inside" })
        .png()
        .toBuffer();
      personaMeta = await sharp(personaProcessed).metadata();
      pW = personaMeta.width;
      pH = personaMeta.height;
      top = Math.max(0, footY - pH);
      top = Math.min(top, baseH - pH);
    }
  }

  // ── Micro-float correction: snap feet exactly to ground line ────────
  let finalPaddingBelow;
  {
    const fp = await detectFootPosition(personaProcessed);
    finalPaddingBelow = fp.paddingBelow;
    const curFootOnCanvas = top + pH - finalPaddingBelow;
    top += (footY - curFootOnCanvas);
    top = Math.round(top);
    top = Math.max(0, Math.min(top, baseH - pH));
  }

  // ── 3. Edge feathering (alpha only — no global blur) ────────────────
  const hasAlpha = personaMeta.channels === 4;
  if (hasAlpha) {
    // Feather only alpha edges (0.5px) — keep RGB channels sharp
    const rgbBuf = await sharp(personaProcessed)
      .removeAlpha()
      .sharpen({ sigma: 0.3 })
      .toColourspace("srgb")
      .png()
      .toBuffer();
    const alphaBuf = await sharp(personaProcessed)
      .extractChannel(3)
      .blur(0.5)
      .png()
      .toBuffer();
    personaProcessed = await sharp(rgbBuf)
      .joinChannel(alphaBuf)
      .png()
      .toBuffer();
  }

  // ── 4. Color & contrast matching ────────────────────────────────────
  // Scene-based brightness + integration adjustments (contrast +7%, sat +4%, brightness -3%)
  const personaBrightness = 150;
  const brightnessFactor = scene.avgBrightness / personaBrightness;
  const clampedBrightness = Math.max(0.65, Math.min(1.35, brightnessFactor));
  const integrationBrightness = clampedBrightness * 0.97;
  const integrationSaturation = (scene.contrast < 40 ? 0.9 : 1.0) * 1.04;

  // Extract alpha before modulate (modulate strips alpha, ensureAlpha would create opaque alpha=255)
  const alphaPreMod2 = await sharp(personaProcessed).extractChannel(3).png().toBuffer();
  personaProcessed = await sharp(personaProcessed).removeAlpha()
    .modulate({ brightness: integrationBrightness, saturation: integrationSaturation })
    .toColourspace("srgb").png().toBuffer();
  personaProcessed = await sharp(personaProcessed).joinChannel(alphaPreMod2).png().toBuffer();

  // Contrast boost (+7%) centered on mid-gray
  {
    const cMeta = await sharp(personaProcessed).metadata();
    const ch = cMeta.channels || 3;
    const cA = ch === 4 ? [1.07, 1.07, 1.07, 1] : [1.07, 1.07, 1.07];
    const cB = ch === 4 ? [-9, -9, -9, 0] : [-9, -9, -9];
    personaProcessed = await sharp(personaProcessed)
      .linear(cA, cB)
      .png()
      .toBuffer();
  }

  // Color temperature shift — dynamically match channel count for linear()
  const warmth = scene.warmth;
  if (Math.abs(warmth) > 0.05) {
    const shift = Math.max(-0.08, Math.min(0.08, warmth * 0.4));
    const curMeta = await sharp(personaProcessed).metadata();
    const ch = curMeta.channels || 3;
    const aArr = ch === 4 ? [1 + shift, 1, 1 - shift, 1] : [1 + shift, 1, 1 - shift];
    const bArr = ch === 4 ? [0, 0, 0, 0] : [0, 0, 0];
    personaProcessed = await sharp(personaProcessed)
      .linear(aArr, bArr)
      .png()
      .toBuffer();
  }

  // Validate persona color before compositing
  {
    const colorCheck = await sharp(personaProcessed).stats();
    const rMean = colorCheck.channels[0].mean;
    const gMean = colorCheck.channels[1].mean;
    const bMean = colorCheck.channels[2].mean;
    console.log(`[COMPOSITE] Persona color: R=${rMean.toFixed(1)} G=${gMean.toFixed(1)} B=${bMean.toFixed(1)}, channels=${colorCheck.channels.length}`);
  }

  // ── 5. Horizontal placement ───────────────────────────────────────
  let left;
  const safeMinX = hMargin;
  const safeMaxX = Math.max(0, baseW - pW - hMargin);

  {
    // Auto / preset placement zones: left ~28%, center ~50%, right ~72%
    switch (placement) {
      case "left":
        left = Math.round(baseW * 0.28 - pW / 2);
        break;
      case "right":
        left = Math.round(baseW * 0.72 - pW / 2);
        break;
      case "center":
        left = Math.round(baseW * 0.50 - pW / 2);
        break;
      case "auto":
      default:
        left = await findOpenFloorPosition(baseBuffer, scene, pW);
        break;
    }
  }

  // Clamp within safe horizontal margins, then hard-clamp to canvas
  left = Math.max(safeMinX, Math.min(left, safeMaxX));
  left = Math.max(0, Math.min(left, baseW - pW));

  // ── Debug logging ─────────────────────────────────────────────────
  const realFootOnCanvas = top + pH - finalPaddingBelow;
  console.log("[COMPOSITE] debug:", JSON.stringify({
    imageSize: `${baseW}x${baseH}`,
    sceneType: isInterior ? "interior" : "exterior",
    personaSize: `${pW}x${pH}`,
    scalePct: `${((pH / baseH) * 100).toFixed(1)}%`,
    groundLineY,
    footAnchorY: footY,
    paddingBelow: finalPaddingBelow,
    realFootOnCanvas,
    finalXY: `(${left}, ${top})`,
    margins: { h: hMargin, b: bMargin, t: tMargin },
    clipped: top < 0 || top + pH > baseH || left < 0 || left + pW > baseW,
  }));

  // ── 6. Dual shadow system ──────────────────────────────────────────
  const layers = [];

  // Soft shadow: larger, lighter, blur 15px, slight directional offset
  try {
    const softW = Math.round(pW * 1.0);
    const softH = Math.max(8, Math.round(pH * 0.12));
    const softSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${softW}" height="${softH}">` +
      `<ellipse cx="${Math.round(softW / 2)}" cy="${Math.round(softH / 2)}" ` +
      `rx="${Math.round(softW * 0.45)}" ry="${Math.round(softH * 0.4)}" ` +
      `fill="black" opacity="0.15"/>` +
      `</svg>`
    );
    const softPng = await sharp(softSvg).png().blur(15).toBuffer();
    const lightOffset = Math.round(scene.warmth * 8);
    const softLeft = Math.round(left + pW / 2 - softW / 2) + lightOffset;
    const softTop = realFootOnCanvas - Math.round(softH * 0.3);
    layers.push({
      input: softPng,
      left: Math.max(0, Math.min(softLeft, baseW - softW)),
      top: Math.max(0, Math.min(softTop, baseH - softH)),
      blend: "over",
    });
  } catch {
    // Non-critical
  }

  // Contact shadow: small, dark, tight under feet, blur 3px
  try {
    const conW = Math.round(pW * 0.5);
    const conH = Math.max(4, Math.round(pH * 0.03));
    const conSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${conW}" height="${conH}">` +
      `<ellipse cx="${Math.round(conW / 2)}" cy="${Math.round(conH / 2)}" ` +
      `rx="${Math.round(conW * 0.45)}" ry="${Math.round(conH * 0.45)}" ` +
      `fill="black" opacity="0.30"/>` +
      `</svg>`
    );
    const conPng = await sharp(conSvg).png().blur(3).toBuffer();
    const conLeft = Math.round(left + pW / 2 - conW / 2);
    const conTop = realFootOnCanvas - Math.round(conH * 0.5);
    layers.push({
      input: conPng,
      left: Math.max(0, Math.min(conLeft, baseW - conW)),
      top: Math.max(0, Math.min(conTop, baseH - conH)),
      blend: "over",
    });
  } catch {
    // Non-critical
  }

  // Persona layer
  layers.push({
    input: personaProcessed,
    left,
    top,
    blend: "over",
  });

  // ── 7. Composite: base → ambient shadow → contact shadow → persona
  const result = await sharp(baseBuffer)
    .composite(layers)
    .jpeg({ quality: 92 })
    .toBuffer();

  return result;
}

// ── Blend: composite a cutout onto a background with exact transform ──

// ── Shadow profile lookup table (lighting-aware) ──────────────────────
// Opacities boosted ~40% from original for more visible, realistic shadows
const SHADOW_PROFILES = {
  golden_hour:     { opacity: 0.28, blur: 20, stretchY: 1.8, angle: 15 },
  midday_sun:      { opacity: 0.48, blur: 8,  stretchY: 0.4, angle: 0 },
  overcast:        { opacity: 0.15, blur: 25, stretchY: 0.6, angle: 0 },
  sunset_dusk:     { opacity: 0.25, blur: 22, stretchY: 2.0, angle: -10 },
  twilight_lights_on: { opacity: 0.12, blur: 18, stretchY: 0.5, angle: 0 },
  warm_cozy:       { opacity: 0.22, blur: 15, stretchY: 0.5, angle: 5 },
  bright_clean:    { opacity: 0.35, blur: 10, stretchY: 0.5, angle: 0 },
  natural_window:  { opacity: 0.28, blur: 18, stretchY: 0.8, angle: 8 },
  moody_cinematic: { opacity: 0.18, blur: 20, stretchY: 0.7, angle: -5 },
  luxury_high_end: { opacity: 0.25, blur: 15, stretchY: 0.6, angle: 3 },
};

// ── Shadow settings helper ────────────────────────────────────────────
// Returns structured shadow settings for a given scene configuration.
function getShadowSettings(sceneType, lightingStyle, feetVisible, shadowIntensity) {
  const profile = lightingStyle
    ? (SHADOW_PROFILES[lightingStyle] || SHADOW_PROFILES.natural_window)
    : SHADOW_PROFILES.natural_window;

  const baseOpacity = profile.opacity * shadowIntensity;
  const enabled = baseOpacity > 0.01;

  return {
    enabled,
    profile,
    baseOpacity,
    // Contact shadow: 2.0× base for tight ground line
    contactOpacity: Math.min(0.55, baseOpacity * 2.0),
    // Ambient shadow: stronger range 0.10-0.18
    ambientOpacity: Math.min(0.18, Math.max(0.10, 0.10 * shadowIntensity)),
    blur: profile.blur,
    stretchY: profile.stretchY,
    angle: profile.angle,
    feetVisible,
  };
}

// ── Lighting color temperature multiplier presets ─────────────────────
const LIGHTING_COLOR_SHIFTS = {
  warm_cozy:       { r: 0.06,  g: 0,     b: -0.04 },
  golden_hour:     { r: 0.08,  g: 0.02,  b: -0.06 },
  overcast:        { r: -0.02, g: -0.01, b: 0.03 },
  moody_cinematic: { r: -0.01, g: 0,     b: 0,     contrast: 1.12 },
  sunset_dusk:     { r: 0.07,  g: 0.01,  b: -0.05 },
  twilight_lights_on: { r: -0.03, g: -0.01, b: 0.04 },
  bright_clean:    { r: 0,     g: 0,     b: 0 },
  natural_window:  { r: 0.02,  g: 0.01,  b: -0.01 },
  luxury_high_end: { r: 0.03,  g: 0.01,  b: -0.02 },
  midday_sun:      { r: 0.01,  g: 0,     b: -0.01 },
};

async function blendPersonaIntoScene(baseBuffer, cutoutBuffer, transform, sceneType, lightingStyle, advanced) {
  const adv = {
    shadowIntensity: advanced?.shadowIntensity ?? 0.5,
    warmthAdjust: advanced?.warmthAdjust ?? 0,
    blendStrength: advanced?.blendStrength ?? 0.8,
  };

  // 1. Scene analysis
  const scene = await analyzeScene(baseBuffer);
  const { width: baseW, height: baseH } = scene;

  const { x = 0.5, y = 0.5, scale = 0.4, rotation = 0, opacity = 1 } = transform || {};

  // 2. Resize cutout
  const cutoutMeta = await sharp(cutoutBuffer).metadata();
  const cutoutSourceH = cutoutMeta.height || 1024;
  const targetH = Math.round(baseH * scale);
  const clampedH = Math.max(50, Math.min(targetH, cutoutSourceH));
  let personaProcessed = await sharp(cutoutBuffer)
    .resize({ height: clampedH, fit: "inside" })
    .png()
    .toBuffer();

  if (targetH > cutoutSourceH) {
    personaProcessed = await sharp(personaProcessed)
      .resize({ height: targetH, fit: "inside", kernel: "lanczos3" })
      .sharpen({ sigma: 0.5, m1: 1.0, m2: 0.5 })
      .png().toBuffer();
  }

  // 3. Perspective grounding — subtle ±3% scale based on vertical position
  const perspectiveScale = 1 + (y - 0.5) * 0.06;
  if (Math.abs(perspectiveScale - 1) > 0.005) {
    const psMeta = await sharp(personaProcessed).metadata();
    const newH = Math.round((psMeta.height || clampedH) * perspectiveScale);
    if (newH > 10) {
      personaProcessed = await sharp(personaProcessed)
        .resize({ height: newH, fit: "inside" })
        .png().toBuffer();
    }
  }

  let pMeta = await sharp(personaProcessed).metadata();
  let pW = pMeta.width;
  let pH = pMeta.height;

  // 4. Rotation
  if (Math.abs(rotation) > 0.5) {
    personaProcessed = await sharp(personaProcessed)
      .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pMeta = await sharp(personaProcessed).metadata();
    pW = pMeta.width;
    pH = pMeta.height;
  }

  // 5. Position + overflow crop
  let left = Math.round(x * baseW - pW / 2);
  let top = Math.round(y * baseH - pH / 2);

  console.log(`[BLEND] transform: x=${x}, y=${y}, scale=${scale}, rot=${rotation}, opacity=${opacity}`);
  console.log(`[BLEND] placement: persona ${pW}x${pH} at (${left},${top}) on ${baseW}x${baseH}`);

  let cropLeft = 0, cropTop = 0, cropRight = 0, cropBottom = 0;
  if (left < 0) { cropLeft = -left; left = 0; }
  if (top < 0) { cropTop = -top; top = 0; }
  if (left + pW > baseW) { cropRight = (left + pW) - baseW; }
  if (top + pH > baseH) { cropBottom = (top + pH) - baseH; }

  const visibleW = pW - cropLeft - cropRight;
  const visibleH = pH - cropTop - cropBottom;

  if (visibleW <= 0 || visibleH <= 0) {
    console.log(`[BLEND] Persona entirely outside canvas, returning base image`);
    return await sharp(baseBuffer).jpeg({ quality: 95 }).toBuffer();
  }

  if (cropLeft > 0 || cropTop > 0 || cropRight > 0 || cropBottom > 0) {
    personaProcessed = await sharp(personaProcessed)
      .extract({ left: cropLeft, top: cropTop, width: visibleW, height: visibleH })
      .png().toBuffer();
    pW = visibleW;
    pH = visibleH;
  }

  // ── Save authoritative alpha right after crop — restored before final composite ──
  const savedAlphaAfterCrop = await sharp(personaProcessed).extractChannel(3).png().toBuffer();

  // 6. Color temperature matching — localized sampling around persona placement
  {
    const strength = adv.blendStrength;
    const colorShift = lightingStyle ? LIGHTING_COLOR_SHIFTS[lightingStyle] : null;
    const curMeta = await sharp(personaProcessed).metadata();
    const ch = curMeta.channels || 3;

    // Sample background around persona placement for localized color matching
    let localWarmth = scene.warmth;
    try {
      const margin = Math.round(Math.max(pW, pH) * 0.3);
      const sLeft = Math.max(0, left - margin);
      const sTop = Math.max(0, top - margin);
      const sW = Math.min(baseW - sLeft, pW + margin * 2);
      const sH = Math.min(baseH - sTop, pH + margin * 2);
      if (sW > 10 && sH > 10) {
        const localStats = await sharp(baseBuffer)
          .extract({ left: sLeft, top: sTop, width: sW, height: sH })
          .stats();
        const localR = localStats.channels[0].mean;
        const localB = localStats.channels[2].mean;
        const localAvg = (localR + localStats.channels[1].mean + localB) / 3;
        localWarmth = localAvg > 0 ? (localR - localB) / localAvg : scene.warmth;
      }
    } catch {
      // fallback to global warmth
    }

    // Combine local warmth with lighting preset and user warmth adjust
    let rShift = (localWarmth > 0 ? localWarmth * 0.3 : localWarmth * 0.2) + (adv.warmthAdjust * 0.1);
    let gShift = 0;
    let bShift = -rShift * 0.6;

    if (colorShift) {
      rShift += colorShift.r * strength;
      gShift += (colorShift.g || 0) * strength;
      bShift += colorShift.b * strength;
    }

    // Clamp shifts
    rShift = Math.max(-0.15, Math.min(0.15, rShift));
    gShift = Math.max(-0.08, Math.min(0.08, gShift));
    bShift = Math.max(-0.15, Math.min(0.15, bShift));

    const aArr = ch === 4 ? [1 + rShift, 1 + gShift, 1 + bShift, 1] : [1 + rShift, 1 + gShift, 1 + bShift];
    const bArr = ch === 4 ? [0, 0, 0, 0] : [0, 0, 0];
    personaProcessed = await sharp(personaProcessed).linear(aArr, bArr).png().toBuffer();
  }

  // 7. Exposure + contrast matching — localized zone-based with face protection
  {
    const strength = adv.blendStrength;

    // Sample local background brightness around persona placement
    let localBrightness = scene.avgBrightness;
    try {
      const margin = Math.round(Math.max(pW, pH) * 0.25);
      const sLeft = Math.max(0, left - margin);
      const sTop = Math.max(0, top - margin);
      const sW = Math.min(baseW - sLeft, pW + margin * 2);
      const sH = Math.min(baseH - sTop, pH + margin * 2);
      if (sW > 10 && sH > 10) {
        const localStats = await sharp(baseBuffer)
          .extract({ left: sLeft, top: sTop, width: sW, height: sH })
          .stats();
        localBrightness = (localStats.channels[0].mean + localStats.channels[1].mean + localStats.channels[2].mean) / 3;
      }
    } catch {}

    const personaBrightness = 150;
    const brightnessFactor = localBrightness / personaBrightness;
    // Face-brightness protection: clamp upward adjustments more aggressively
    // to avoid blowing out skin/shirts on bright backgrounds
    const maxBright = brightnessFactor > 1 ? 1.20 : 1.35;
    const iBright = Math.max(0.65, Math.min(maxBright, brightnessFactor)) * 0.97;
    const iSat = (scene.contrast < 40 ? 0.9 : 1.0) * 1.04;

    // Blend brightness adjustment with strength
    const adjBright = 1 + (iBright - 1) * strength;
    const adjSat = 1 + (iSat - 1) * strength;

    // Extract alpha before modulate (modulate strips alpha, ensureAlpha would create opaque alpha=255)
    const alphaPreMod3 = await sharp(personaProcessed).extractChannel(3).png().toBuffer();
    personaProcessed = await sharp(personaProcessed).removeAlpha()
      .modulate({ brightness: adjBright, saturation: adjSat })
      .toColourspace("srgb").png().toBuffer();
    personaProcessed = await sharp(personaProcessed).joinChannel(alphaPreMod3).png().toBuffer();

    // Adaptive contrast: high-contrast scenes → stronger, soft scenes → softer
    const contrastMult = scene.contrast > 50 ? 1.10 : scene.contrast > 30 ? 1.07 : 1.03;
    const lightingContrast = lightingStyle ? (LIGHTING_COLOR_SHIFTS[lightingStyle]?.contrast || 1) : 1;
    const finalContrast = 1 + (contrastMult * lightingContrast - 1) * strength;
    const contrastOffset = Math.round(-((finalContrast - 1) * 128));

    const cMeta = await sharp(personaProcessed).metadata();
    const ch = cMeta.channels || 3;
    const cA = ch === 4 ? [finalContrast, finalContrast, finalContrast, 1] : [finalContrast, finalContrast, finalContrast];
    const cB = ch === 4 ? [contrastOffset, contrastOffset, contrastOffset, 0] : [contrastOffset, contrastOffset, contrastOffset];
    personaProcessed = await sharp(personaProcessed).linear(cA, cB).png().toBuffer();
  }

  // 8. Edge blending — adaptive feather + color bleed + ambient occlusion
  {
    const curMeta = await sharp(personaProcessed).metadata();
    if (curMeta.channels === 4) {
      // Adaptive feather based on resolution (0.8–2.0px, wider than before)
      const maxDim = Math.max(baseW, baseH);
      const featherSigma = Math.max(0.8, Math.min(2.0, maxDim / 1500));

      const alphaBuf = await sharp(personaProcessed).extractChannel(3).blur(featherSigma).png().toBuffer();
      const rgbBuf = await sharp(personaProcessed).removeAlpha().toColourspace("srgb").png().toBuffer();

      // Color bleed: sample background around persona placement, tint edges
      try {
        const bleedSize = 5;
        const sampleLeft = Math.max(0, left - bleedSize);
        const sampleTop = Math.max(0, top - bleedSize);
        const sampleW = Math.min(baseW - sampleLeft, pW + bleedSize * 2);
        const sampleH = Math.min(baseH - sampleTop, pH + bleedSize * 2);

        if (sampleW > 0 && sampleH > 0) {
          const borderStats = await sharp(baseBuffer)
            .extract({ left: sampleLeft, top: sampleTop, width: sampleW, height: sampleH })
            .stats();
          const borderR = Math.round(borderStats.channels[0].mean);
          const borderG = Math.round(borderStats.channels[1].mean);
          const borderB = Math.round(borderStats.channels[2].mean);

          // Create tint overlay at 15% opacity on edges (up from 10%)
          const tintSvg = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${pW}" height="${pH}"><rect width="${pW}" height="${pH}" fill="rgb(${borderR},${borderG},${borderB})" opacity="0.15"/></svg>`
          );
          const tintBuf = await sharp(tintSvg).png().toBuffer();

          // Apply tint only where alpha transitions (edges) using alpha as mask
          const edgeAlpha = await sharp(personaProcessed).extractChannel(3)
            .blur(featherSigma + 0.5)
            .negate()
            .linear([2], [-200])
            .png().toBuffer();

          const tintWithEdge = await sharp(tintBuf).joinChannel(edgeAlpha).png().toBuffer();

          // Ambient occlusion: subtle 4% darken at cutout boundary
          const aoSvg = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${pW}" height="${pH}"><rect width="${pW}" height="${pH}" fill="rgb(0,0,0)" opacity="0.04"/></svg>`
          );
          const aoBuf = await sharp(aoSvg).png().toBuffer();
          const aoWithEdge = await sharp(aoBuf).joinChannel(edgeAlpha).png().toBuffer();

          const rgbTinted = await sharp(rgbBuf)
            .composite([
              { input: tintWithEdge, blend: "over" },
              { input: aoWithEdge, blend: "over" },
            ])
            .png().toBuffer();

          personaProcessed = await sharp(rgbTinted).joinChannel(alphaBuf).png().toBuffer();
        } else {
          personaProcessed = await sharp(rgbBuf).joinChannel(alphaBuf).png().toBuffer();
        }
      } catch {
        personaProcessed = await sharp(rgbBuf).joinChannel(alphaBuf).png().toBuffer();
      }
    }
  }

  // 9. Contact shadow — lighting-aware profile (using getShadowSettings helper)
  const layers = [];
  const feetVisible = (y + scale * 0.4) < 1.05 && (top + pH + cropBottom) >= (baseH * 0.8);

  // Sample floor color for shadow tinting
  let shadowColorR = 0, shadowColorG = 0, shadowColorB = 0;
  try {
    const floorSampleTop = Math.round(baseH * 0.85);
    const floorSampleH = Math.max(1, baseH - floorSampleTop);
    const floorStats = await sharp(baseBuffer)
      .extract({ left: Math.round(baseW * 0.2), top: floorSampleTop, width: Math.round(baseW * 0.6), height: floorSampleH })
      .stats();
    shadowColorR = Math.round(floorStats.channels[0].mean * 0.4);
    shadowColorG = Math.round(floorStats.channels[1].mean * 0.4);
    shadowColorB = Math.round(floorStats.channels[2].mean * 0.4);
  } catch {
    shadowColorR = 20; shadowColorG = 20; shadowColorB = 20;
  }

  const shadow = getShadowSettings(sceneType, lightingStyle, feetVisible, adv.shadowIntensity);

  // 10. Ambient shadow — silhouette behind persona (stronger range: 0.10-0.18)
  if (shadow.enabled) {
    try {
      const ambientAlpha = await sharp(personaProcessed).extractChannel(3)
        .blur(Math.max(1, Math.min(30, Math.round(pH * 0.06))))
        .png().toBuffer();

      const ambientSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${pW}" height="${pH}"><rect width="${pW}" height="${pH}" fill="rgb(${shadowColorR},${shadowColorG},${shadowColorB})" opacity="${shadow.ambientOpacity.toFixed(3)}"/></svg>`
      );
      const ambientColor = await sharp(ambientSvg).png().toBuffer();
      const ambientLayer = await sharp(ambientColor).joinChannel(ambientAlpha).png().toBuffer();

      layers.push({ input: ambientLayer, left, top, blend: "over" });
    } catch {}
  }

  if (shadow.feetVisible && shadow.enabled) {
    const footY = top + pH;
    const angleRad = (shadow.angle * Math.PI) / 180;
    const offsetX = Math.round(Math.sin(angleRad) * pH * 0.05);

    // Soft ground shadow
    try {
      const softW = Math.round(pW * 1.1);
      const softH = Math.max(8, Math.round(pH * shadow.stretchY * 0.1));
      const softSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${softW}" height="${softH}"><ellipse cx="${Math.round(softW / 2)}" cy="${Math.round(softH / 2)}" rx="${Math.round(softW * 0.45)}" ry="${Math.round(softH * 0.4)}" fill="rgb(${shadowColorR},${shadowColorG},${shadowColorB})" opacity="${Math.min(0.55, shadow.baseOpacity).toFixed(3)}"/></svg>`
      );
      const blurVal = Math.max(1, Math.min(50, shadow.blur));
      const softPng = await sharp(softSvg).png().blur(blurVal).toBuffer();
      const sLeft = Math.max(0, Math.min(baseW - softW, Math.round(left + pW / 2 - softW / 2 + offsetX)));
      const sTop = Math.max(0, Math.min(baseH - softH, footY - Math.round(softH * 0.3)));
      if (sLeft + softW <= baseW && sTop + softH <= baseH) {
        layers.push({ input: softPng, left: sLeft, top: sTop, blend: "over" });
      }
    } catch {}

    // Tight contact shadow (2.0× multiplier for stronger ground line)
    try {
      const conW = Math.round(pW * 0.5);
      const conH = Math.max(4, Math.round(pH * 0.03));
      const conSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${conW}" height="${conH}"><ellipse cx="${Math.round(conW / 2)}" cy="${Math.round(conH / 2)}" rx="${Math.round(conW * 0.45)}" ry="${Math.round(conH * 0.45)}" fill="rgb(${shadowColorR},${shadowColorG},${shadowColorB})" opacity="${shadow.contactOpacity.toFixed(3)}"/></svg>`
      );
      const conPng = await sharp(conSvg).png().blur(3).toBuffer();
      const cLeft = Math.max(0, Math.min(baseW - conW, Math.round(left + pW / 2 - conW / 2 + offsetX * 0.3)));
      const cTop = Math.max(0, Math.min(baseH - conH, footY - Math.round(conH * 0.5)));
      if (cLeft + conW <= baseW && cTop + conH <= baseH) {
        layers.push({ input: conPng, left: cLeft, top: cTop, blend: "over" });
      }
    } catch {}
  }

  // 11. Noise/grain matching
  try {
    const strength = adv.blendStrength;
    if (strength > 0.05) {
      // Sample representative background patch (center-right, avoiding sky)
      const patchLeft = Math.round(baseW * 0.55);
      const patchTop = Math.round(baseH * 0.4);
      const patchW = Math.min(Math.round(baseW * 0.2), baseW - patchLeft);
      const patchH = Math.min(Math.round(baseH * 0.2), baseH - patchTop);

      if (patchW > 10 && patchH > 10) {
        const patch = await sharp(baseBuffer)
          .extract({ left: patchLeft, top: patchTop, width: patchW, height: patchH })
          .toBuffer();

        const patchStats = await sharp(patch).stats();
        const patchBlurred = await sharp(patch).blur(2).stats();

        // Noise level: difference in stdev between original and blurred
        const noiseLevel = Math.max(
          0,
          ((patchStats.channels[0].stdev - patchBlurred.channels[0].stdev) +
           (patchStats.channels[1].stdev - patchBlurred.channels[1].stdev) +
           (patchStats.channels[2].stdev - patchBlurred.channels[2].stdev)) / 3
        );

        if (noiseLevel > 1) {
          // Generate matching grain: noise buffer at similar stdev
          const grainIntensity = Math.min(30, Math.round(noiseLevel * strength * 1.5));
          // Create a neutral gray buffer with noise-like pattern via raw data
          const grainW = pW;
          const grainH = pH;
          // Extract persona alpha so grain only affects opaque regions
          const personaAlphaForGrain = await sharp(personaProcessed).extractChannel(3).raw().toBuffer();

          const grainData = Buffer.alloc(grainW * grainH * 4);
          for (let i = 0; i < grainW * grainH; i++) {
            const noise = Math.round((Math.random() - 0.5) * grainIntensity * 2);
            const val = Math.max(0, Math.min(255, 128 + noise));
            grainData[i * 4] = val;
            grainData[i * 4 + 1] = val;
            grainData[i * 4 + 2] = val;
            // Use persona's alpha so grain doesn't make transparent pixels opaque
            grainData[i * 4 + 3] = personaAlphaForGrain[i] || 0;
          }

          const grainBuf = await sharp(grainData, { raw: { width: grainW, height: grainH, channels: 4 } })
            .png().toBuffer();

          // Composite grain over persona using soft-light blend
          // Preserve original alpha after composite to prevent any alpha bleed
          const preGrainAlpha = await sharp(personaProcessed).extractChannel(3).png().toBuffer();
          const grainedRgba = await sharp(personaProcessed)
            .composite([{ input: grainBuf, blend: "soft-light" }])
            .png().toBuffer();
          // Re-apply original alpha to ensure transparency is untouched
          const grainedRgb = await sharp(grainedRgba).removeAlpha().png().toBuffer();
          personaProcessed = await sharp(grainedRgb).joinChannel(preGrainAlpha).png().toBuffer();
        }
      }
    }
  } catch {}

  // 12. Apply opacity
  if (opacity < 1) {
    const opMeta = await sharp(personaProcessed).metadata();
    if (opMeta.channels === 4) {
      const rgb = await sharp(personaProcessed).removeAlpha().png().toBuffer();
      const alpha = await sharp(personaProcessed).extractChannel(3)
        .linear([opacity], [0]).png().toBuffer();
      personaProcessed = await sharp(rgb).joinChannel(alpha).png().toBuffer();
    }
  }

  // 13. Final mild sharpen — preserve alpha through sharpen
  {
    const preSharpenAlpha = await sharp(personaProcessed).extractChannel(3).png().toBuffer();
    const sharpenedRgb = await sharp(personaProcessed).removeAlpha()
      .sharpen({ sigma: 0.4, m1: 0.8, m2: 0.4 })
      .png().toBuffer();
    personaProcessed = await sharp(sharpenedRgb).joinChannel(preSharpenAlpha).png().toBuffer();
  }

  // ── Restore authoritative alpha (bulletproof — overrides any alpha corruption from steps 6-13) ──
  {
    const rgbOnly = await sharp(personaProcessed).removeAlpha().png().toBuffer();
    personaProcessed = await sharp(rgbOnly).joinChannel(savedAlphaAfterCrop).png().toBuffer();
  }

  // 14. Composite all layers
  layers.push({ input: personaProcessed, left, top, blend: "over" });

  console.log(`[BLEND] Result: persona ${pW}x${pH} at (${left},${top}), feetVisible=${feetVisible}, lighting=${lightingStyle || 'auto'}, shadow=${shadow.baseOpacity.toFixed(2)}`);
  return await sharp(baseBuffer).composite(layers).jpeg({ quality: 95 }).toBuffer();
}

// ── Main job processor ────────────────────────────────────────────────

async function processJob(assetId, overrides) {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
  });
  if (!asset) throw new Error(`Media asset ${assetId} not found`);

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

    // Extract mode flags
    const isComposite = !!overrides?.compositeMode;
    const isCutoutMode = !!overrides?.cutoutMode;
    const isBlendMode = !!overrides?.blendMode;
    const referenceImageUrl = overrides?.referenceImageUrl;
    const composePlacement = overrides?.composePlacement ?? "auto";
    const personaLayer = overrides?.composePersonaLayer ?? null;
    const framing = personaLayer?.framingPreset ?? overrides?.framingPreset ?? 'full_body';

    // Clean mode flags from overrides
    if (isComposite) {
      delete overrides.compositeMode;
      delete overrides.referenceImageUrl;
      delete overrides.composePlacement;
      delete overrides.composePersonaLayer;
    }
    if (isCutoutMode) {
      delete overrides.cutoutMode;
      delete overrides.framingPreset;
    }

    // ── Blend mode: composite existing cutout onto background ────────────
    if (isBlendMode) {
      const { backgroundImageUrl, cutoutImageUrl, transform, sceneType, lightingStyle, advanced } = overrides;
      delete overrides.blendMode;
      delete overrides.backgroundImageUrl;
      delete overrides.cutoutImageUrl;
      delete overrides.transform;
      delete overrides.sceneType;
      delete overrides.lightingStyle;
      delete overrides.advanced;

      await setStage(assetId, "Downloading images");
      const [baseBuffer, rawCutoutBuffer] = await Promise.all([
        loadImageBuffer(backgroundImageUrl, "background"),
        loadImageBuffer(cutoutImageUrl, "persona cutout"),
      ]);

      // Validate cutout transparency at pixel level — metadata hasAlpha is NOT enough
      // (an RGBA image can have alpha=255 everywhere = fully opaque black background)
      let cutoutBuffer = rawCutoutBuffer;
      const cutoutMeta = await sharp(rawCutoutBuffer).metadata();
      console.log(`[BLEND] Cutout: ${cutoutMeta.width}x${cutoutMeta.height}, channels=${cutoutMeta.channels}, hasAlpha=${cutoutMeta.hasAlpha}, format=${cutoutMeta.format}`);

      let validation = await validateCutoutTransparency(rawCutoutBuffer);

      if (!validation.hasTransparency) {
        console.log(`[BLEND] Cutout FAILED pixel-level transparency check (${validation.reason}) — running background removal fallback`);
        await setStage(assetId, "Removing background");
        try {
          const fallbackUrl = await removeBackground(cutoutImageUrl);
          console.log("[BLEND] Background removal fallback returned an asset URL");
          cutoutBuffer = await loadImageBuffer(fallbackUrl, "persona cutout (bg-removed)");

          const fixedValidation = await validateCutoutTransparency(cutoutBuffer);
          if (!fixedValidation.hasTransparency) {
            console.error(`[BLEND] Background removal fallback also failed transparency check (${fixedValidation.reason})`);
            throw new Error("Background removal did not produce a transparent image");
          }
          console.log(`[BLEND] Background removal fallback succeeded — transparency validated`);
        } catch (bgErr) {
          console.error(`[BLEND] Background removal fallback failed:`, bgErr.message);
          throw new Error("Could not isolate the persona — the cutout image has no transparency. Please regenerate the persona cutout.");
        }
      } else {
        console.log(`[BLEND] Cutout transparency validated: ${validation.transparentCorners}/4 corners, ${(validation.transparentPixelRatio * 100).toFixed(1)}% transparent`);
      }

      await setStage(assetId, "Blending into scene");
      const finalBuffer = await blendPersonaIntoScene(baseBuffer, cutoutBuffer, transform, sceneType, lightingStyle, advanced);

      await setStage(assetId, "Uploading");
      const storage = getImageStorageService();
      const uploaded = await storage.upload(finalBuffer, {
        folder: `squadpitch/${asset.clientId}/generated`,
      });

      const updated = await prisma.mediaAsset.update({
        where: { id: assetId },
        data: {
          status: "READY", progressStage: null,
          url: uploaded.url, publicId: uploaded.publicId,
          width: uploaded.width, height: uploaded.height,
          bytes: uploaded.bytes, mimeType: uploaded.format ? `image/${uploaded.format}` : null,
          durationMs: Date.now() - started,
        },
      });

      if (updated.draftId) {
        const draft = await prisma.draft.findUnique({ where: { id: updated.draftId }, select: { mediaUrl: true } });
        if (draft && !draft.mediaUrl) {
          await prisma.draft.update({ where: { id: updated.draftId }, data: { mediaUrl: updated.url } });
        }
      }

      return { assetId: updated.id };
    }

    // 2. Call Fal.ai
    let result;
    const MAX_COMPOSITE_RETRIES = 3;

    if (isComposite || isCutoutMode) {
      // Canvas size based on framing mode — use 1024-based sizes for sharp cutouts
      const FRAMING_CANVAS = {
        full_body: { width: 1024, height: 1536 },
        three_quarter: { width: 1024, height: 1365 },
        waist_up: { width: 1024, height: 1280 },
        bust: { width: 1024, height: 1024 },
      };
      input.image_size = FRAMING_CANVAS[framing] || FRAMING_CANVAS.full_body;
      console.log(`[COMPOSITE] Framing: ${framing}, canvas: ${input.image_size.width}x${input.image_size.height}, cutoutMode=${isCutoutMode}`);

      if (framing === 'full_body') {
        // Full-body: retry loop with validation
        for (let attempt = 1; attempt <= MAX_COMPOSITE_RETRIES; attempt++) {
          await setStage(assetId, attempt > 1
            ? `Generating persona (retry ${attempt})`
            : "Generating persona");
          result = await submitGeneration({ modelId: asset.falModelId, input });
          recordServiceSuccess("fal").catch(() => {});

          const img = result.images?.[0];
          if (!img?.url) throw new Error("Fal returned no image URL");

          const isFullBody = await checkFullBody(img.url);
          if (isFullBody || attempt === MAX_COMPOSITE_RETRIES) {
            console.log(`[COMPOSITE] Full-body: ${isFullBody ? "PASS" : "FAIL (using anyway)"}, attempt ${attempt}`);
            break;
          }
          console.log(`[COMPOSITE] Full-body FAIL, attempt ${attempt}/${MAX_COMPOSITE_RETRIES}, retrying...`);
        }
      } else {
        // Non-full-body framing: single generation, no full-body check
        await setStage(assetId, "Generating persona");
        result = await submitGeneration({ modelId: asset.falModelId, input });
        recordServiceSuccess("fal").catch(() => {});
      }
    } else {
      await setStage(assetId, "Generating");
      result = await submitGeneration({ modelId: asset.falModelId, input });
      recordServiceSuccess("fal").catch(() => {});
    }

    const firstImage = result.images?.[0];
    if (!firstImage?.url) {
      throw new Error("Fal returned no image URL");
    }

    let finalBuffer;
    let outputFormat = "jpeg"; // default

    if (isCutoutMode) {
      // ── Cutout mode: generate + remove background → transparent PNG ──
      await setStage(assetId, "Removing background");
      console.log("[CUTOUT] Sending generated image to birefnet");
      const cutoutUrl = await removeBackground(firstImage.url);
      console.log("[CUTOUT] Birefnet returned an asset URL");

      await setStage(assetId, "Processing cutout");
      finalBuffer = await loadImageBuffer(cutoutUrl, "persona cutout");

      // Validate transparency at pixel level before storing
      const cutoutValidation = await validateCutoutTransparency(finalBuffer);
      if (!cutoutValidation.hasTransparency) {
        console.warn(`[CUTOUT] WARNING: birefnet output failed pixel transparency check (${cutoutValidation.reason}), retrying bg removal on original...`);
        await setStage(assetId, "Retrying background removal");
        // Retry with a different approach: re-run birefnet
        const retryUrl = await removeBackground(firstImage.url);
        finalBuffer = await loadImageBuffer(retryUrl, "persona cutout (retry)");
        const retryValidation = await validateCutoutTransparency(finalBuffer);
        if (!retryValidation.hasTransparency) {
          console.error(`[CUTOUT] Retry also failed transparency check (${retryValidation.reason})`);
          // Still proceed — the blend fallback will catch it
        } else {
          console.log(`[CUTOUT] Retry succeeded — transparency validated`);
        }
      }

      // Keep as PNG to preserve transparency
      outputFormat = "png";
      console.log(`[CUTOUT] Generated transparent cutout for asset ${assetId}`);
    } else if (isComposite && referenceImageUrl) {
      // ── Compositing pipeline ──────────────────────────────
      await setStage(assetId, "Removing background");
      const cutoutUrl = await removeBackground(firstImage.url);

      await setStage(assetId, "Compositing");
      const [baseBuffer, personaBuffer] = await Promise.all([
        loadImageBuffer(referenceImageUrl, "original photo"),
        loadImageBuffer(cutoutUrl, "persona cutout"),
      ]);

      finalBuffer = await compositeImages(baseBuffer, personaBuffer, composePlacement, personaLayer);
    } else {
      // ── Standard generation — download and normalize ──────
      await setStage(assetId, "Downloading");
      finalBuffer = await loadImageBuffer(firstImage.url, "generated image");
      finalBuffer = await sharp(finalBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    // Convert to output format if needed
    if (outputFormat === "jpeg" && !isCutoutMode) {
      // Already handled above or by compositeImages
    }

    // 3. Upload to Cloudinary.
    await setStage(assetId, "Uploading");
    const storage = getImageStorageService();
    const uploaded = await storage.upload(finalBuffer, {
      folder: `squadpitch/${asset.clientId}/generated`,
      ...(isCutoutMode && { preserveAlpha: true }),
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
        seed: result.seed != null ? (() => { try { const v = BigInt(result.seed); return v >= 0n && v <= 9223372036854775807n ? v : null; } catch { return null; } })() : null,
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

    // 6. Record activity
    const creator = await prisma.user.findUnique({
      where: { auth0Sub: asset.createdBy },
      select: { id: true },
    });
    if (creator) {
      recordActivity({
        userId: creator.id,
        clientId: asset.clientId,
        eventType: "MEDIA_GENERATED",
        payload: { assetType: "image", composite: isComposite, clientId: asset.clientId },
        resourceType: "asset",
        resourceId: updated.id,
      }).catch(() => {});
    }

    return { assetId: updated.id };
  } catch (err) {
    recordServiceFailure("fal").catch(() => {});
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
