// SAM 2 segmentation service — calls Replicate and returns per-mask bboxes.
//
// Replicate's `meta/sam-2` returns mask PNGs as URLs. We download each mask,
// decode it with sharp, and compute the tight bbox of non-zero pixels. All
// bboxes are normalized to 0..1 so downstream filters are resolution-agnostic.

import sharp from "sharp";
import { runModel, ReplicateProviderError } from "./replicate.client.js";
import { env } from "../../../config/env.js";

const DEFAULT_MODEL = env.REPLICATE_SAM2_MODEL ?? "meta/sam-2";

/**
 * Run SAM 2 automatic mask generation on a screenshot.
 *
 * @param {object} params
 * @param {string} params.imageUrl - data URL or http(s) URL of the screenshot
 * @param {number} [params.pointsPerSide=32]
 * @returns {Promise<{ masks: string[], modelRef: string }>}
 */
export async function runSam2Segmentation({ imageUrl, pointsPerSide = 32 }) {
  if (!imageUrl) {
    throw new ReplicateProviderError("imageUrl is required", {
      code: "REPLICATE_BAD_REQUEST",
      status: 400,
    });
  }

  // Replicate.run() for meta/sam-2 returns:
  //   { combined_mask: <url>, individual_masks: <url[]> }
  const output = await runModel(DEFAULT_MODEL, {
    image: imageUrl,
    points_per_side: pointsPerSide,
    pred_iou_thresh: 0.88,
    stability_score_thresh: 0.95,
    use_m2m: true,
  });

  // The SDK can return streams, URL-like objects (sync or async .url()),
  // or plain strings depending on the version. Normalize to plain strings.
  const toUrl = async (x) => {
    if (!x) return null;
    if (typeof x === "string") return x;
    if (typeof x === "object" && typeof x.url === "function") {
      try {
        const maybePromise = x.url();
        const resolved = maybePromise && typeof maybePromise.then === "function"
          ? await maybePromise
          : maybePromise;
        if (!resolved) return null;
        if (typeof resolved === "string") return resolved;
        if (typeof resolved === "object" && typeof resolved.toString === "function") {
          const s = resolved.toString();
          return s.startsWith("http") ? s : null;
        }
        return null;
      } catch {
        return null;
      }
    }
    if (typeof x === "object" && typeof x.url === "string") return x.url;
    // Last resort — coerce to string but reject obvious junk like "[object Object]"
    try {
      const s = String(x);
      return s.startsWith("http") ? s : null;
    } catch {
      return null;
    }
  };

  const individual = Array.isArray(output?.individual_masks)
    ? output.individual_masks
    : [];
  const masks = (await Promise.all(individual.map(toUrl))).filter(Boolean);

  return { masks, modelRef: DEFAULT_MODEL, rawMaskCount: individual.length };
}

/**
 * Decode a mask PNG URL and return the tight bbox of non-zero pixels,
 * normalized to 0..1 against the mask's own dimensions (which match the
 * source screenshot).
 *
 * Returns `null` if the mask is empty, all-black, or unreadable.
 */
export async function maskToBbox(maskUrl) {
  try {
    const res = await fetch(maskUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());

    // Decode to single-channel raw bytes for speed.
    const { data, info } = await sharp(buf)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    if (!width || !height) return null;

    // Find tight bbox of non-zero pixels. Mask pixels are binary (~0 or ~255).
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const THRESHOLD = 32; // treat anything brighter than this as "mask on"
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        if (data[rowOff + x] > THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // empty mask

    return {
      x: minX / width,
      y: minY / height,
      w: (maxX - minX + 1) / width,
      h: (maxY - minY + 1) / height,
    };
  } catch {
    return null;
  }
}

/**
 * Parallel bbox extraction for a batch of mask URLs, bounded concurrency
 * so we don't fan out to dozens of simultaneous downloads.
 */
export async function masksToBboxes(maskUrls, { concurrency = 6 } = {}) {
  const results = [];
  for (let i = 0; i < maskUrls.length; i += concurrency) {
    const slice = maskUrls.slice(i, i + concurrency);
    const batch = await Promise.all(slice.map((u) => maskToBbox(u)));
    results.push(...batch);
  }
  return results;
}
