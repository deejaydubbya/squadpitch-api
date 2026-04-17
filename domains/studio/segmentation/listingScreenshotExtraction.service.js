// Listing screenshot extraction — SAM 2 segmentation + scored post-processing.
//
// Pipeline (spinstr102):
//   1. Run SAM 2 on Replicate → individual_masks[]
//   2. Decode every mask → bbox
//   3. For each bbox: sample the source-image crop via sharp.stats()
//   4. Hard-filter (geometry, flat color, below-gallery)
//   5. Score survivors (position, aspect, size, stdev, entropy, color range)
//   6. IoU dedupe (keep higher score)
//   7. Take top 5, largest = hero, rest = gallery tiles
//   8. Synthesize a galleryContainer for the frontend overlay
//
// OpenAI is NOT used anywhere in this path. Text field extraction
// (address/price/etc.) happens in a separate parallel call.

import sharp from "sharp";
import { runSam2Segmentation, masksToBboxes } from "./sam2.service.js";
import { iou, synthesizeGalleryContainer } from "./cropFiltering.js";
import {
  fetchSourceBuffer,
  computeCropStats,
  hardReject,
  scoreSegment,
  classifyMedia,
  detectContentRegion,
} from "./cropScoring.js";
import { pickBestCluster } from "./clusterDetection.js";

const LABEL_FALLBACK = "other";

function buildRegion({ id, bbox, rank, layoutRole, label = LABEL_FALLBACK, score, mediaType }) {
  return {
    id,
    label,
    description: layoutRole === "hero" ? "Hero image" : "Gallery tile",
    layoutRole,
    photoConfidence: Math.max(0, Math.min(1, (score ?? 80) / 120)),
    hasText: false,
    quality: "bright",
    bbox,
    rank,
    sourcePass: "replicate_sam2",
    source: layoutRole === "hero" ? "hero" : "gallery_tile",
    extractionSource: "replicate_sam2",
    score,
    mediaType: mediaType ?? "property_photo",
  };
}

/**
 * Dedupe scored candidates by IoU, keeping the higher-scoring box when two
 * segments overlap past the threshold (current: 0.4 — aggressive because
 * SAM 2 loves to emit nested masks of the same photo).
 */
function dedupeByScore(candidates, iouThreshold = 0.4) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const cand of sorted) {
    const overlap = kept.find((k) => iou(k.bbox, cand.bbox) >= iouThreshold);
    if (!overlap) kept.push(cand);
  }
  return kept;
}

/**
 * Salvage a fragmented hero — spinstr111.
 *
 * SAM sometimes splits a single wide/tall listing photo into 2-4 adjacent
 * slices (horizontal bands across an exterior photo, vertical strips through
 * a panorama, etc). Each slice individually is small, often gets rejected as
 * `extreme_banner`, or survives with a low "tileSize" score. This pass:
 *
 *   1. Collects photo-like fragments in the upper media zone (cy < 0.6,
 *      photo-like pixel stats, NOT ui/ad).
 *   2. Also recovers "soft-rejected" photo-looking fragments (extreme_banner
 *      with photo signals, too_tall, full_width_thin) that were lost at
 *      hard reject — these are exactly the pieces of a split hero.
 *   3. Union-finds adjacency (touching or near-touching + perpendicular
 *      overlap) so a row of bands becomes one group.
 *   4. Produces a merged candidate per group ≥ 2 members whose union bbox
 *      is (a) meaningfully larger than the biggest member and (b)
 *      still photo-like when re-sampled via `computeCropStats`.
 *
 * Returns an array of fully-scored, fully-classified candidates tagged with
 * `isSalvaged: true` and `memberIds: [...]`.
 */
async function salvageAdjacentFragments({ scored, rejected, sourceBuf, srcW, srcH }) {
  if (!sourceBuf || !srcW || !srcH) return [];

  const UPPER_Y = 0.6;
  const SOFT_REJECTS = new Set([
    "extreme_banner",
    "too_tall",
    "full_width_thin",
  ]);

  // Scored fragments that are plausibly photo pieces.
  const scoredFrags = scored.filter((c) => {
    const stats = c.stats;
    if (!stats) return false;
    const cy = c.bbox.y + c.bbox.h / 2;
    if (cy >= UPPER_Y) return false;
    if (c.mediaType === "ui" || c.mediaType === "ad") return false;
    if (c.bbox.w * c.bbox.h < 0.006) return false; // too tiny
    if (stats.stdev < 18) return false;
    if (stats.entropy < 4.8) return false;
    if ((stats.textScore ?? 0) >= 0.4) return false;
    return true;
  });

  // Soft-rejected photo-looking fragments (banners with photo signals etc.).
  // Recompute stats if they survived (rejected entries already have stats).
  const softRejectFrags = rejected
    .filter((r) => SOFT_REJECTS.has(r.rejectReason))
    .filter((r) => {
      if (!r.stats) return false;
      const cy = r.bbox.y + r.bbox.h / 2;
      if (cy >= UPPER_Y) return false;
      if (r.stats.stdev < 20) return false;
      if (r.stats.entropy < 5.0) return false;
      if ((r.stats.textScore ?? 0) >= 0.4) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      bbox: r.bbox,
      stats: r.stats,
      score: 0,
      mediaType: "unknown",
      fromSoftReject: true,
      rejectReason: r.rejectReason,
    }));

  const frags = [...scoredFrags, ...softRejectFrags];
  if (frags.length < 2) return [];

  // Adjacency union-find.
  const n = frags.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const ADJ_GAP = 0.02;           // near-touching
  const PERP_OVERLAP_FRAC = 0.3;  // overlap in perpendicular axis
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = frags[i].bbox;
      const b = frags[j].bbox;
      const gapX = Math.max(
        0,
        Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w),
      );
      const gapY = Math.max(
        0,
        Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h),
      );
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const minW = Math.min(a.w, b.w);
      const minH = Math.min(a.h, b.h);
      const sideBySide =
        gapX <= ADJ_GAP && overlapY >= PERP_OVERLAP_FRAC * minH;
      const stacked =
        gapY <= ADJ_GAP && overlapX >= PERP_OVERLAP_FRAC * minW;
      if (sideBySide || stacked) union(i, j);
    }
  }

  // Group into adjacency clusters.
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(frags[i]);
  }

  const out = [];
  let idx = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;

    // Union bbox.
    let x1 = 1;
    let y1 = 1;
    let x2 = 0;
    let y2 = 0;
    for (const m of members) {
      x1 = Math.min(x1, m.bbox.x);
      y1 = Math.min(y1, m.bbox.y);
      x2 = Math.max(x2, m.bbox.x + m.bbox.w);
      y2 = Math.max(y2, m.bbox.y + m.bbox.h);
    }
    const unionBbox = {
      x: x1,
      y: y1,
      w: Math.max(0, x2 - x1),
      h: Math.max(0, y2 - y1),
    };
    const unionArea = unionBbox.w * unionBbox.h;
    const largestMemberArea = Math.max(
      ...members.map((m) => m.bbox.w * m.bbox.h),
    );

    // Must be a meaningful combination — reject "merge" that's basically
    // already one of the members (happens when one frag nests the others).
    if (unionArea < largestMemberArea * 1.25) continue;
    // Must be large enough to be worth salvaging (hero-sized region).
    if (unionArea < 0.05) continue;

    // Re-sample pixel stats on the union bbox. If the merged region looks
    // cohesive and photo-like, keep it.
    // eslint-disable-next-line no-await-in-loop
    const stats = await computeCropStats(sourceBuf, unionBbox, srcW, srcH);
    if (!stats) continue;
    if (stats.stdev < 20 || stats.entropy < 5.0) continue;
    if ((stats.textScore ?? 0) >= 0.4) continue;

    // Score + classify the salvaged candidate just like a regular one.
    const { score: baseScore, reasons } = scoreSegment({ bbox: unionBbox, stats });
    const mediaType = classifyMedia({ bbox: unionBbox, stats });
    let adjustedScore = baseScore;
    const adjReasons = { ...reasons };
    if (mediaType === "floorplan") {
      adjustedScore -= 50;
      adjReasons.floorplanPenalty = -50;
    } else if (mediaType === "map") {
      adjustedScore -= 40;
      adjReasons.mapPenalty = -40;
    } else if (mediaType === "ui") {
      adjustedScore -= 60;
      adjReasons.uiPenalty = -60;
    } else if (mediaType === "ad") {
      adjustedScore -= 60;
      adjReasons.adPenalty = -60;
    }
    // Bonus for successful salvage — we trust merged hero-sized photo-like
    // regions as strong hero candidates.
    adjustedScore += 10;
    adjReasons.salvageBonus = +10;

    out.push({
      id: `salvage_${idx}`,
      bbox: unionBbox,
      stats,
      score: adjustedScore,
      reasons: adjReasons,
      mediaType,
      isSalvaged: true,
      memberIds: members.map((m) => m.id),
      memberCount: members.length,
    });
    idx += 1;
  }
  return out;
}

/**
 * Extract hero + gallery images from a listing screenshot using SAM 2 and
 * pixel-aware scoring.
 *
 * @param {object} params
 * @param {string} params.imageUrl  - data URL or http(s) URL
 * @param {boolean} [params.debug=false]
 */
export async function extractListingScreenshot({ imageUrl, debug = false }) {
  const started = Date.now();

  // 1. Source buffer (once — reused for every crop's stats call).
  const sourceBuf = await fetchSourceBuffer(imageUrl);
  let srcW = 0;
  let srcH = 0;
  if (sourceBuf) {
    try {
      const meta = await sharp(sourceBuf).metadata();
      srcW = meta.width ?? 0;
      srcH = meta.height ?? 0;
    } catch {
      /* leave 0/0 — scoring will skip pixel signals */
    }
  }

  // 1b. Detect content region (strip black/solid margins from desktop
  //     screenshot viewers that embed mobile listing pages). This lets us
  //     penalise segments outside the content area so desktop chrome /
  //     viewer UI doesn't compete with real listing photos for ranking.
  const contentRegion = await detectContentRegion(sourceBuf);
  const hasContentTrim =
    contentRegion.x > 0.01 ||
    contentRegion.y > 0.01 ||
    contentRegion.w < 0.98 ||
    contentRegion.h < 0.98;

  // 2. Segment everything
  const { masks, modelRef, rawMaskCount } = await runSam2Segmentation({ imageUrl });
  const totalMasks = masks.length;

  // 3. Decode masks → bboxes
  const rawBboxes = await masksToBboxes(masks);
  const decoded = rawBboxes
    .map((bbox, i) => (bbox ? { id: `mask_${i}`, bbox } : null))
    .filter(Boolean);

  // 4. Stats for every candidate (bounded concurrency via Promise.all chunks)
  const CONCURRENCY = 6;
  const withStats = [];
  for (let i = 0; i < decoded.length; i += CONCURRENCY) {
    const slice = decoded.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      slice.map(async (c) => ({
        ...c,
        stats: await computeCropStats(sourceBuf, c.bbox, srcW, srcH),
      })),
    );
    withStats.push(...batch);
  }

  // 5. Hard reject + score + classify
  const rejected = [];
  const scored = [];
  for (const cand of withStats) {
    // 5a. Content-region filter — reject segments that sit almost entirely
    //     outside the detected content area (desktop viewer chrome, black
    //     margins, etc.). We keep anything whose center is inside.
    if (hasContentTrim) {
      const cx = cand.bbox.x + cand.bbox.w / 2;
      const cy = cand.bbox.y + cand.bbox.h / 2;
      const insideX =
        cx >= contentRegion.x && cx <= contentRegion.x + contentRegion.w;
      const insideY =
        cy >= contentRegion.y && cy <= contentRegion.y + contentRegion.h;
      if (!insideX || !insideY) {
        rejected.push({
          id: cand.id,
          bbox: cand.bbox,
          rejectReason: "outside_content",
          stats: cand.stats,
        });
        continue;
      }
    }

    const rejectReason = hardReject(cand);
    if (rejectReason) {
      rejected.push({
        id: cand.id,
        bbox: cand.bbox,
        rejectReason,
        stats: cand.stats,
      });
      continue;
    }
    const { score, reasons } = scoreSegment(cand);
    // Classify AFTER scoring so we can apply type-specific penalties.
    const mediaType = classifyMedia(cand);
    let adjustedScore = score;
    const adjReasons = { ...reasons };
    if (mediaType === "floorplan") {
      adjustedScore -= 50;
      adjReasons.floorplanPenalty = -50;
    } else if (mediaType === "map") {
      adjustedScore -= 40;
      adjReasons.mapPenalty = -40;
    } else if (mediaType === "ui") {
      adjustedScore -= 60;
      adjReasons.uiPenalty = -60;
    } else if (mediaType === "ad") {
      adjustedScore -= 60;
      adjReasons.adPenalty = -60;
    }
    scored.push({
      ...cand,
      score: adjustedScore,
      reasons: adjReasons,
      mediaType,
    });
  }

  // 5b. SALVAGE PASS (spinstr111) — SAM often fragments a wide hero photo
  //     into 2-4 thin slices (the exterior house in the reference
  //     screenshot was split into horizontal bands). Individually each
  //     slice is either rejected as `extreme_banner` or scored low as
  //     "tileSize" — neither can win hero. We detect adjacency between
  //     photo-like fragments in the upper media zone and emit a merged
  //     candidate covering the full region. The merged candidate is
  //     scored + classified like any other segment.
  const salvaged = await salvageAdjacentFragments({
    scored,
    rejected,
    sourceBuf,
    srcW,
    srcH,
  });
  if (salvaged.length > 0) {
    scored.push(...salvaged);
  }

  // 6. Dedupe by IoU, keep higher score.
  //    Use an elevated IoU threshold (0.3) for salvage-vs-member pairs so
  //    fragments get consumed by their salvaged parent even at partial
  //    overlap, but regular-vs-regular dedupe still uses 0.4.
  const dedupedRaw = dedupeByScore(scored, 0.4);
  // Drop fragment members whose parent salvage survived.
  const consumedMemberIds = new Set();
  for (const c of dedupedRaw) {
    if (c.isSalvaged && Array.isArray(c.memberIds)) {
      for (const mid of c.memberIds) consumedMemberIds.add(mid);
    }
  }
  const deduped = dedupedRaw.filter((c) => !consumedMemberIds.has(c.id));

  // 6a. Split into property photos vs schematic media vs ads/ui. Only
  //     property_photo can ever become hero OR enter default selection
  //     (spinstr109 #3 — hard exclusion of ads/maps/floorplans/ui).
  const propertyPhotos = deduped.filter((c) => c.mediaType === "property_photo");
  const schematic = deduped.filter(
    (c) => c.mediaType === "floorplan" || c.mediaType === "map",
  );
  const commercial = deduped.filter(
    (c) => c.mediaType === "ad" || c.mediaType === "ui",
  );

  // ── SPINSTR109 — HERO-FIRST EXTRACTION FLOW ─────────────────────────
  //
  // The previous flow clustered first, then selected a hero from the
  // chosen cluster. That loses the hero when the correct one is in a
  // different spatial region (e.g. left hero + right thumbnail strip).
  //
  // New flow:
  //   1. Global pass → find the provisional hero anchor (largest strong
  //      property_photo whose center is in the upper half).
  //   2. Hero-anchored gallery search → find supporting property photos
  //      near the anchor (right / below / above / grid layouts).
  //   3. Clustering runs only as fallback when no hero anchor exists.
  //   4. Ads, maps, floorplans, ui are NEVER hero, NEVER in default pick.
  //
  // spinstr109.

  // 7. GLOBAL PHOTO CANDIDATE PASS — pick the provisional hero anchor.
  //    Rules:
  //      - MUST be classified property_photo
  //      - Prefer upper half (cy < 0.5) but accept up to 0.65 if nothing
  //        qualifies higher
  //      - Must be hero-sized (area ≥ 0.04) — thumbnails are never hero
  //      - Must have a positive-ish score (≥ 0) so garbage photos don't win
  const HERO_MIN_AREA = 0.04;
  const HERO_UPPER_Y = 0.5;
  const HERO_FALLBACK_Y = 0.65;
  function pickProvisionalHero(photos) {
    if (photos.length === 0) return { anchor: null, reason: "no_property_photos" };
    const candidates = photos.filter((c) => {
      const a = c.bbox.w * c.bbox.h;
      return a >= HERO_MIN_AREA && (c.score ?? 0) >= 0;
    });
    if (candidates.length === 0) {
      return { anchor: null, reason: "no_hero_size_photo" };
    }
    const upperHalf = candidates.filter(
      (c) => c.bbox.y + c.bbox.h / 2 < HERO_UPPER_Y,
    );
    const pool = upperHalf.length > 0
      ? { list: upperHalf, zone: "upper_half" }
      : {
          list: candidates.filter((c) => c.bbox.y + c.bbox.h / 2 < HERO_FALLBACK_Y),
          zone: "upper_two_thirds",
        };
    if (pool.list.length === 0) {
      return { anchor: null, reason: "no_photo_in_upper_region" };
    }
    // Largest-area wins (spec #5).
    const anchor = pool.list
      .slice()
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];
    return { anchor, reason: "ok", zone: pool.zone, poolSize: pool.list.length };
  }
  const heroPick = pickProvisionalHero(propertyPhotos);
  const originalProvisionalHero = heroPick.anchor;
  let provisionalHero = originalProvisionalHero;

  // 7a-force. FORCE-HERO FALLBACK (spinstr110 #6).
  //
  // The previous fix picks the provisional hero from candidates ALREADY
  // classified as property_photo. If classifyMedia() tagged the real
  // exterior as `ad` / `map` / `floorplan` / `unknown` (vivid palette,
  // unusual color range), it's never eligible for hero candidacy.
  //
  // This fallback ignores classification: if the largest upper-half
  // segment with photo-like pixel stats exists and is substantially
  // larger than whatever property_photo was picked, force-promote it.
  const FORCE_HERO_MIN_AREA = 0.08;
  const FORCE_HERO_MAX_Y = 0.55;
  const forceHeroPool = scored.filter((c) => {
    const cy = c.bbox.y + c.bbox.h / 2;
    const cArea = c.bbox.w * c.bbox.h;
    const stdev = c.stats?.stdev ?? 0;
    const textScore = c.stats?.textScore ?? 0;
    const entropy = c.stats?.entropy ?? 0;
    return (
      cArea >= FORCE_HERO_MIN_AREA &&
      cy < FORCE_HERO_MAX_Y &&
      stdev >= 20 &&
      textScore < 0.35 &&
      entropy >= 4.5 &&
      c.mediaType !== "ui"
    );
  });
  const forceHeroCandidate = forceHeroPool
    .slice()
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0] ?? null;
  let forceHeroApplied = false;
  let forceHeroReason = null;
  if (forceHeroCandidate) {
    const fhArea = forceHeroCandidate.bbox.w * forceHeroCandidate.bbox.h;
    const phArea = provisionalHero
      ? provisionalHero.bbox.w * provisionalHero.bbox.h
      : 0;
    if (!provisionalHero) {
      provisionalHero = forceHeroCandidate;
      forceHeroApplied = true;
      forceHeroReason = "no_provisional_hero";
    } else if (
      forceHeroCandidate !== provisionalHero &&
      fhArea > phArea * 1.3
    ) {
      provisionalHero = forceHeroCandidate;
      forceHeroApplied = true;
      forceHeroReason = "larger_than_provisional";
    }
  }

  // 7b. HERO-ANCHORED GALLERY SEARCH — find supporting photos near the
  //     anchor. "Near" supports all listing layouts: hero + right thumb
  //     strip, hero + below grid, stacked hero/thumb pairs, carousels.
  //
  //     Neighbourhood rules per candidate `c` relative to `hero`:
  //       - center-to-center distance < 0.55 (normalized)
  //       - OR spatial proximity: gap in EITHER axis < 0.1 AND overlap
  //         in the OTHER axis > 0 (side-by-side or stacked)
  //       - must be classified property_photo
  //       - smaller than hero (don't attach same-size-or-larger siblings
  //         as "supporting" — those would compete for hero)
  function findNeighbors(hero, photos) {
    if (!hero) return [];
    const hb = hero.bbox;
    const heroArea = hb.w * hb.h;
    const hcx = hb.x + hb.w / 2;
    const hcy = hb.y + hb.h / 2;
    const out = [];
    for (const c of photos) {
      if (c === hero) continue;
      const cArea = c.bbox.w * c.bbox.h;
      if (cArea > heroArea * 0.9) continue; // same-or-larger competes for hero
      const ccx = c.bbox.x + c.bbox.w / 2;
      const ccy = c.bbox.y + c.bbox.h / 2;
      const centerDist = Math.hypot(ccx - hcx, ccy - hcy);
      const gapX = Math.max(0, Math.max(hb.x, c.bbox.x) - Math.min(hb.x + hb.w, c.bbox.x + c.bbox.w));
      const gapY = Math.max(0, Math.max(hb.y, c.bbox.y) - Math.min(hb.y + hb.h, c.bbox.y + c.bbox.h));
      const overlapX =
        Math.min(hb.x + hb.w, c.bbox.x + c.bbox.w) - Math.max(hb.x, c.bbox.x) > 0;
      const overlapY =
        Math.min(hb.y + hb.h, c.bbox.y + c.bbox.h) - Math.max(hb.y, c.bbox.y) > 0;
      const sideBySide = gapX < 0.1 && overlapY;
      const stacked = gapY < 0.1 && overlapX;
      if (centerDist < 0.55 || sideBySide || stacked) out.push(c);
    }
    // Rank neighbors by score desc so the best supports show first.
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  // When force-hero overrode classification, neighbor search should also
  // look outside the property_photo pool — nearby tiles may be misclassified
  // for the same reason as the hero. Keep ads/ui out regardless.
  const neighborPool = forceHeroApplied
    ? scored.filter((c) => c.mediaType !== "ui" && c.mediaType !== "ad")
    : propertyPhotos;
  const heroNeighbors = findNeighbors(provisionalHero, neighborPool);

  // 7c. Run clustering on the property-photo pool as a SECONDARY signal
  //     (spec #4). We still expose it in diagnostics and use it as
  //     fallback when the hero-first flow couldn't anchor anything.
  const clusterResult = pickBestCluster(propertyPhotos, {
    maxGapX: 0.08,
    maxGapY: 0.08,
    mergeMaxGapX: 0.35,
    mergeMaxGapY: 0.15,
    verticalOverlapMin: 0.3,
  });
  const chosenCluster = clusterResult.chosen;

  // 7d. Build the final ranked list:
  //   - Primary path: provisional hero + its neighbors, top 5.
  //   - Fallback 1: chosen cluster members (legacy behaviour).
  //   - Fallback 2: any property_photo sorted by score.
  //   - Fallback 3: anything deduped.
  //   - Fallback 4 (rescue): raw scored / soft-rejected salvage.
  let ranked = [];
  let selectionSource = "none";
  let galleryAttached = 0;
  if (provisionalHero) {
    const supporting = heroNeighbors.slice(0, 4);
    ranked = [provisionalHero, ...supporting].slice(0, 5);
    galleryAttached = supporting.length;
    selectionSource = "hero_anchored";
  } else if (chosenCluster && chosenCluster.size >= 2 && chosenCluster.score > 20) {
    ranked = [...chosenCluster.members]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    selectionSource = "cluster_fallback";
  } else if (propertyPhotos.length > 0) {
    ranked = [...propertyPhotos].sort((a, b) => b.score - a.score).slice(0, 5);
    selectionSource = "property_photos";
  } else if (deduped.length > 0) {
    // No property_photo at all — this is the ONLY path where ads/maps
    // etc. could appear, and it should be rare. Still exclude ads/ui
    // from this fallback (they can never be hero per spec #3).
    const nonCommercial = deduped.filter(
      (c) => c.mediaType !== "ad" && c.mediaType !== "ui",
    );
    ranked = [...(nonCommercial.length > 0 ? nonCommercial : deduped)]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    selectionSource = "any_deduped";
  }

  // 7e. Rescue pass — score-based fallback when nothing survived.
  if (ranked.length === 0 && scored.length > 0) {
    const nonCommercial = scored.filter(
      (c) => c.mediaType !== "ad" && c.mediaType !== "ui",
    );
    ranked = [...(nonCommercial.length > 0 ? nonCommercial : scored)]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    selectionSource = "rescue_scored";
  }

  // 7f. Last-ditch rescue — score the rejected pool's soft rejects.
  if (ranked.length === 0 && rejected.length > 0) {
    const SOFT_REJECTS = new Set([
      "flat_color",
      "white_ui_panel",
      "black_ui_panel",
      "full_width_thin",
      "extreme_banner",
      "too_tall",
    ]);
    const salvageable = rejected
      .filter((r) => SOFT_REJECTS.has(r.rejectReason))
      .map((r) => {
        const { score, reasons } = scoreSegment({ bbox: r.bbox, stats: r.stats });
        return { ...r, score, reasons };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (salvageable.length > 0) {
      ranked = salvageable;
      selectionSource = "rescue_salvage";
    }
  }

  // 8. HERO RULE (spec #5): hero MUST be property_photo. Provisional hero
  //    is already property_photo by construction. Fall back rules:
  //      - if ranked[0] is property_photo, use it
  //      - else pick largest property_photo in ranked
  //      - else NO hero (we'd rather return null than promote a non-photo)
  let heroRaw;
  if (provisionalHero && ranked.includes(provisionalHero)) {
    heroRaw = provisionalHero;
  } else {
    const photoRanked = ranked.filter((c) => c.mediaType === "property_photo");
    heroRaw = photoRanked.length > 0
      ? photoRanked
          .slice()
          .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0]
      : null;
  }
  const galleryRaw = heroRaw
    ? ranked.filter((c) => c !== heroRaw).slice(0, 4)
    : ranked.slice(0, 4);

  const heroImage = heroRaw
    ? buildRegion({
        id: "hero",
        bbox: heroRaw.bbox,
        rank: 0,
        layoutRole: "hero",
        score: heroRaw.score,
        mediaType: heroRaw.mediaType,
      })
    : null;

  const galleryImages = galleryRaw.map((c, i) =>
    buildRegion({
      id: `tile_${i}`,
      bbox: c.bbox,
      rank: i + 1,
      layoutRole: "gallery",
      score: c.score,
      mediaType: c.mediaType,
    }),
  );

  const galleryContainer = synthesizeGalleryContainer(heroImage, galleryImages);

  const imageRegions = [
    ...(heroImage ? [heroImage] : []),
    ...galleryImages,
  ];

  // Always-on diagnostics — cheap counts only, safe to return in prod so we
  // can see WHY extraction returned empty without requiring ?debug=1.
  const rejectBreakdown = rejected.reduce((acc, r) => {
    acc[r.rejectReason] = (acc[r.rejectReason] ?? 0) + 1;
    return acc;
  }, {});
  const mediaTypeBreakdown = scored.reduce((acc, c) => {
    acc[c.mediaType ?? "unknown"] = (acc[c.mediaType ?? "unknown"] ?? 0) + 1;
    return acc;
  }, {});

  // spinstr109 #6 — find the largest segment across the whole dedupe pool and
  // report WHY it was (or wasn't) classified as property_photo. This answers
  // the "why is the biggest exterior image excluded?" question directly.
  const largestOverall = deduped
    .slice()
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];
  const largestOverallDiag = largestOverall
    ? {
        id: largestOverall.id,
        bbox: largestOverall.bbox,
        area: Math.round(largestOverall.bbox.w * largestOverall.bbox.h * 10000) / 10000,
        mediaType: largestOverall.mediaType,
        score: Math.round(largestOverall.score),
        reasonsApplied: largestOverall.reasons,
        classifiedAsPropertyPhoto: largestOverall.mediaType === "property_photo",
      }
    : null;

  // ── SPINSTR110 — CANDIDATE-LEVEL PIPELINE INSTRUMENTATION ───────────
  //
  // Track exactly what happens to the largest upper-half candidate through
  // each stage. This is the question the user needs answered for the
  // exterior-house failure: "was it produced by SAM? where was it lost?"
  //
  // Stages: decoded → withStats → (rejected | scored) → deduped →
  //         propertyPhotos → ranked.
  //
  // We also produce an `upperMediaDump` listing EVERY upper-half candidate
  // with its fate, so we can see whether the exterior was split/fragmented
  // (multiple large boxes competing), never produced, or produced and
  // mis-filtered.
  const UPPER_CY_MAX = 0.5;
  const decodedUpper = decoded
    .map((c) => ({
      id: c.id,
      bbox: c.bbox,
      area: c.bbox.w * c.bbox.h,
      cy: c.bbox.y + c.bbox.h / 2,
    }))
    .filter((c) => c.cy < UPPER_CY_MAX)
    .sort((a, b) => b.area - a.area);
  const trackedRaw = decodedUpper[0] ?? null;
  const trackedId = trackedRaw?.id ?? null;

  const findById = (arr, id) => (id ? arr.find((c) => c.id === id) : null);
  const largestUpperTrace = trackedRaw
    ? {
        id: trackedRaw.id,
        bbox: trackedRaw.bbox,
        area: Math.round(trackedRaw.area * 10000) / 10000,
        cy: Math.round(trackedRaw.cy * 1000) / 1000,
        stages: (() => {
          const stats = findById(withStats, trackedId);
          const rej = findById(rejected, trackedId);
          const sc = findById(scored, trackedId);
          const de = findById(deduped, trackedId);
          const pp = findById(propertyPhotos, trackedId);
          const rk = findById(ranked, trackedId);
          return {
            decoded: true,
            withStats: !!stats,
            statsSnapshot: stats?.stats
              ? {
                  stdev: Math.round(stats.stats.stdev * 10) / 10,
                  entropy: Math.round(stats.stats.entropy * 100) / 100,
                  colorRange: Math.round(stats.stats.colorRange * 10) / 10,
                  domLum: Math.round(stats.stats.domLum),
                  textScore: Math.round((stats.stats.textScore ?? 0) * 100) / 100,
                }
              : null,
            hardRejected: !!rej,
            hardRejectReason: rej?.rejectReason ?? null,
            scored: !!sc,
            score: sc ? Math.round(sc.score) : null,
            mediaType: sc?.mediaType ?? null,
            inDeduped: !!de,
            isPropertyPhoto: !!pp,
            inRanked: !!rk,
            isProvisionalHero: provisionalHero && provisionalHero.id === trackedId,
            isHero: heroRaw && heroRaw.id === trackedId,
          };
        })(),
      }
    : { present: false, reason: "no_upper_half_candidates" };

  // Full upper-media dump — every upper-half decoded candidate with its fate.
  const upperMediaDump = decodedUpper.map((d) => {
    const sc = findById(scored, d.id);
    const rej = findById(rejected, d.id);
    const inDeduped = !!findById(deduped, d.id);
    const inPropPhotos = !!findById(propertyPhotos, d.id);
    const inRanked = !!findById(ranked, d.id);
    let fate = "unknown";
    if (rej) fate = `rejected:${rej.rejectReason}`;
    else if (!sc) fate = "no_stats_or_dropped";
    else if (!inDeduped) fate = "deduped_out";
    else if (inRanked) fate = "selected";
    else if (inPropPhotos) fate = "photo_not_selected";
    else fate = `${sc.mediaType ?? "unknown"}_excluded`;
    return {
      id: d.id,
      bbox: d.bbox,
      area: Math.round(d.area * 10000) / 10000,
      fate,
      mediaType: sc?.mediaType ?? null,
      score: sc ? Math.round(sc.score) : null,
      rejectReason: rej?.rejectReason ?? null,
    };
  });

  // spinstr109 #6 — report why the legacy "dense right-side cluster" would
  // now be rejected, specifically whether it would have lacked the hero
  // anchor, contained a non-photo, or been outscored by the hero-anchored
  // flow.
  const clusterMembersInRanked = chosenCluster
    ? chosenCluster.members.filter((m) => ranked.includes(m)).length
    : 0;
  const clusterRejectionReason = (() => {
    if (selectionSource === "hero_anchored") {
      if (!chosenCluster) return "no_cluster_formed";
      const clusterContainsHero = chosenCluster.members.includes(provisionalHero);
      if (clusterContainsHero) return "hero_in_cluster_but_anchored_flow_wins";
      return "cluster_excluded_hero_anchor";
    }
    if (selectionSource === "cluster_fallback") return "cluster_used_as_fallback";
    return "cluster_not_selected";
  })();

  const diagnostics = {
    modelRef,
    rawMaskCount: rawMaskCount ?? totalMasks,
    totalMasks,
    afterDecode: decoded.length,
    rejectedCount: rejected.length,
    rejectBreakdown,
    scoredCount: scored.length,
    mediaTypeBreakdown,
    propertyPhotoCount: propertyPhotos.length,
    schematicCount: schematic.length,
    commercialExcludedCount: commercial.length,
    afterDedupe: deduped.length,
    clusterCount: clusterResult.clusters.length,
    chosenClusterSize: chosenCluster?.size ?? 0,
    chosenClusterScore: chosenCluster
      ? Math.round(chosenCluster.score)
      : null,
    chosenClusterBbox: chosenCluster?.bbox ?? null,
    clusterMembersInRanked,
    clusterRejectionReason,
    clusterMerged: !!clusterResult.mergeInfo?.merged,
    mergedFromSize: clusterResult.mergeInfo?.satelliteSize ?? null,
    selectionSource,
    // spinstr109 — hero-first flow diagnostics.
    heroAnchoredRan: !!provisionalHero,
    provisionalHeroId: provisionalHero?.id ?? null,
    provisionalHeroBbox: provisionalHero?.bbox ?? null,
    provisionalHeroScore: provisionalHero
      ? Math.round(provisionalHero.score)
      : null,
    provisionalHeroMediaType: provisionalHero?.mediaType ?? null,
    provisionalHeroArea: provisionalHero
      ? Math.round(provisionalHero.bbox.w * provisionalHero.bbox.h * 10000) / 10000
      : null,
    heroPickReason: heroPick.reason,
    heroPickZone: heroPick.zone ?? null,
    heroPickPoolSize: heroPick.poolSize ?? 0,
    galleryAttached,
    largestOverall: largestOverallDiag,
    // spinstr110 — force-hero diagnostics
    forceHeroApplied,
    forceHeroReason,
    forceHeroCandidateId: forceHeroCandidate?.id ?? null,
    forceHeroCandidateArea: forceHeroCandidate
      ? Math.round(forceHeroCandidate.bbox.w * forceHeroCandidate.bbox.h * 10000) / 10000
      : null,
    forceHeroCandidateMediaType: forceHeroCandidate?.mediaType ?? null,
    originalProvisionalHeroId: originalProvisionalHero?.id ?? null,
    // spinstr111 — salvage diagnostics
    salvagedCount: salvaged.length,
    salvaged: salvaged.map((s) => ({
      id: s.id,
      bbox: s.bbox,
      area: Math.round(s.bbox.w * s.bbox.h * 10000) / 10000,
      score: Math.round(s.score),
      mediaType: s.mediaType,
      memberIds: s.memberIds,
      memberCount: s.memberCount,
      selected: ranked.includes(s),
      isHero: heroRaw === s,
    })),
    consumedFragmentCount: consumedMemberIds.size,
    // spinstr110 — candidate-level pipeline trace
    largestUpperTrace,
    upperMediaDump,
    selectedCount: ranked.length,
    heroFound: !!heroImage,
    heroMediaType: heroImage?.mediaType ?? null,
    galleryCount: galleryImages.length,
    contentRegion,
    hasContentTrim,
    tookMs: Date.now() - started,
    srcW,
    srcH,
  };

  const result = {
    galleryContainer,
    heroImage,
    galleryImages,
    imageRegions,
    detectedCount: imageRegions.length,
    extractionSource: "replicate_sam2",
    diagnostics,
  };

  if (debug) {
    result.debug = {
      ...diagnostics,
      clusters: clusterResult.clusters.map((cl) => ({
        bbox: cl.bbox,
        size: cl.size,
        score: Math.round(cl.score),
        avgScore: Math.round(cl.avgScore ?? 0),
        avgText: Math.round((cl.avgText ?? 0) * 100) / 100,
        density: Math.round((cl.density ?? 0) * 100) / 100,
        photoFrac: Math.round((cl.photoFrac ?? 0) * 100) / 100,
        hasHero: !!cl.hasHero,
        composition: cl.composition ?? 0,
        containsProvisionalHero: !!(
          provisionalHero && cl.members.includes(provisionalHero)
        ),
        reasons: cl.reasons,
        chosen: cl === chosenCluster,
      })),
      heroNeighborIds: heroNeighbors.slice(0, 4).map((c) => c.id),
      excludedFromHero: {
        ads: commercial.filter((c) => c.mediaType === "ad").map((c) => c.id),
        ui: commercial.filter((c) => c.mediaType === "ui").map((c) => c.id),
        maps: schematic.filter((c) => c.mediaType === "map").map((c) => c.id),
        floorplans: schematic
          .filter((c) => c.mediaType === "floorplan")
          .map((c) => c.id),
      },
      // Full candidate + rejection lists for the frontend overlay.
      candidates: scored.map((c) => ({
        id: c.id,
        bbox: c.bbox,
        score: c.score,
        reasons: c.reasons,
        mediaType: c.mediaType,
        stats: c.stats
          ? {
              stdev: Math.round(c.stats.stdev * 10) / 10,
              entropy: Math.round(c.stats.entropy * 100) / 100,
              colorRange: Math.round(c.stats.colorRange * 10) / 10,
              domLum: Math.round(c.stats.domLum),
              textScore: Math.round((c.stats.textScore ?? 0) * 100) / 100,
              transitionX: Math.round((c.stats.transitionX ?? 0) * 100) / 100,
              transitionY: Math.round((c.stats.transitionY ?? 0) * 100) / 100,
            }
          : null,
        selected: ranked.includes(c),
        isProvisionalHero: c === provisionalHero,
        isHeroNeighbor: heroNeighbors.includes(c),
      })),
      rejected: rejected.map((r) => ({
        id: r.id,
        bbox: r.bbox,
        rejectReason: r.rejectReason,
        stats: r.stats
          ? {
              stdev: Math.round(r.stats.stdev * 10) / 10,
              entropy: Math.round(r.stats.entropy * 100) / 100,
              colorRange: Math.round(r.stats.colorRange * 10) / 10,
              domLum: Math.round(r.stats.domLum),
            }
          : null,
      })),
    };
  }

  return result;
}

/**
 * Empty-result stub used when Replicate is unavailable. Lets the endpoint
 * still return a usable shape so the UI can surface the manual-crop
 * fallback without exploding.
 */
export function emptyExtraction({ reason = "unavailable" } = {}) {
  return {
    galleryContainer: null,
    heroImage: null,
    galleryImages: [],
    imageRegions: [],
    detectedCount: 0,
    extractionSource: "replicate_sam2",
    diagnostics: { reason, totalMasks: 0, scoredCount: 0, rejectedCount: 0, selectedCount: 0 },
    debug: { reason },
  };
}
