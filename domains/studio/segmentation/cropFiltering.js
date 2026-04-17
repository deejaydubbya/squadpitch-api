// Pure geometric helpers for the SAM 2 post-processing pipeline.
// All bboxes are normalized to the range 0..1.

/** Area of a bbox. */
export function area(b) {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

/** Intersection area between two bboxes. */
export function intersectionArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/** Intersection-over-union. */
export function iou(a, b) {
  const inter = intersectionArea(a, b);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Fraction of `inner` contained inside `outer`. */
export function containment(inner, outer) {
  const inner_area = area(inner);
  if (inner_area <= 0) return 0;
  return intersectionArea(inner, outer) / inner_area;
}

/**
 * Reject candidates that are too small, too large, wrong aspect, or sit
 * outside the top gallery zone of the page.
 */
export function sizeAndZoneFilter(bbox) {
  const MIN_DIM = 0.05;     // >=5% of screenshot in each dimension
  const MAX_BOTH = 0.85;    // reject full-page fragments
  const AR_MIN = 0.35;
  const AR_MAX = 3.2;
  const GALLERY_Y_MAX = 0.70; // center must sit in the top 70%

  if (bbox.w < MIN_DIM || bbox.h < MIN_DIM) return false;
  if (bbox.w >= MAX_BOTH && bbox.h >= MAX_BOTH) return false;
  const ar = bbox.w / bbox.h;
  if (ar < AR_MIN || ar > AR_MAX) return false;
  const cy = bbox.y + bbox.h / 2;
  if (cy > GALLERY_Y_MAX) return false;
  return true;
}

/**
 * Dedupe by IoU. When two candidates overlap past `iouThreshold`, keep the
 * larger one.
 */
export function dedupe(candidates, iouThreshold = 0.5) {
  const sorted = [...candidates].sort((a, b) => area(b.bbox) - area(a.bbox));
  const kept = [];
  for (const cand of sorted) {
    const overlap = kept.find((k) => iou(k.bbox, cand.bbox) >= iouThreshold);
    if (!overlap) kept.push(cand);
  }
  return kept;
}

/**
 * Given a list of candidates that passed filtering + dedupe, rank them:
 *  - largest → hero
 *  - remaining sorted by area desc → gallery tiles
 *
 * Returns `{ hero, gallery }` with both slots populated when available.
 */
export function rankHeroAndGallery(candidates, { maxGallery = 7 } = {}) {
  const sorted = [...candidates].sort((a, b) => area(b.bbox) - area(a.bbox));
  const hero = sorted[0] ?? null;
  const gallery = sorted.slice(1, 1 + maxGallery);
  return { hero, gallery };
}

/**
 * Synthesize a `galleryContainer` bbox from hero + tiles. Useful for the
 * frontend debug overlay and for enforcing a final containment check on
 * manual overrides.
 */
export function synthesizeGalleryContainer(hero, tiles) {
  const all = [hero, ...tiles].filter(Boolean);
  if (all.length === 0) return null;
  const xs = all.map((c) => c.bbox.x);
  const ys = all.map((c) => c.bbox.y);
  const xs2 = all.map((c) => c.bbox.x + c.bbox.w);
  const ys2 = all.map((c) => c.bbox.y + c.bbox.h);
  const x = Math.max(0, Math.min(...xs) - 0.01);
  const y = Math.max(0, Math.min(...ys) - 0.01);
  const x2 = Math.min(1, Math.max(...xs2) + 0.01);
  const y2 = Math.min(1, Math.max(...ys2) + 0.01);
  return {
    bbox: { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) },
    confidence: 0.9,
    reason: "synthesized from hero + gallery tiles",
    sourcePass: "replicate_sam2",
  };
}
