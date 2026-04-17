// Media cluster detection for the SAM 2 post-processing pipeline.
//
// Problem: scoring segments independently works for "pick the best photo",
// but real listing pages layout photos as *groups* — hero + thumbnail strip,
// grid of tiles, carousel row, etc. If we can first identify the cluster
// that represents the photo gallery, we can aggressively reject noise
// (sidebar ads, maps, floorplans, header chrome) without hand-tuning each
// site's layout.
//
// Cluster scoring signals (from spinstr106):
//   - number of image-like segments in the cluster
//   - combined photo-likeness (avg score of members)
//   - spatial alignment / proximity (tight bounding box)
//   - position in upper page region (y < 0.5 preferred)
//   - low text/UI density among members
//   - presence of a hero-sized member (at least one ≥ 0.04 area)
//
// The output is a ranked list of clusters; the pipeline keeps the top one
// and restricts candidate selection to its members (with single-segment
// fallback when no cluster has ≥ 2 members).

import { area } from "./cropFiltering.js";

/**
 * Group candidates into clusters based on spatial proximity. Two candidates
 * join the same cluster when they are *near* each other — defined as the
 * gap between bounding boxes being small relative to their own sizes. This
 * naturally picks up:
 *   - hero above a thumbnail strip (vertical stack)
 *   - hero left of a thumbnail column (horizontal neighbours)
 *   - 2×2 / 3×3 grids of tiles
 *
 * Uses union-find on candidate indices.
 *
 * @param {Array} candidates - each has { bbox, score, mediaType, stats }
 * @param {object} opts
 * @param {number} [opts.maxGapX=0.08] - max normalized horizontal gap to link
 * @param {number} [opts.maxGapY=0.08] - max normalized vertical gap to link
 */
export function buildClusters(candidates, opts = {}) {
  const maxGapX = opts.maxGapX ?? 0.08;
  const maxGapY = opts.maxGapY ?? 0.08;
  const n = candidates.length;
  if (n === 0) return [];

  // Union-find
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

  // Pairwise proximity (O(n²) — n is always ≤ ~50 post-filter).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = candidates[i].bbox;
      const b = candidates[j].bbox;
      // Gap along each axis (0 if overlapping).
      const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
      const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
      if (gapX <= maxGapX && gapY <= maxGapY) {
        union(i, j);
      }
    }
  }

  // Collect groups.
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(candidates[i]);
  }

  return [...groups.values()].map((members) => ({
    members,
    bbox: clusterBbox(members),
  }));
}

/** Union bbox of all cluster members (normalized). */
function clusterBbox(members) {
  if (!members.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
  for (const m of members) {
    x1 = Math.min(x1, m.bbox.x);
    y1 = Math.min(y1, m.bbox.y);
    x2 = Math.max(x2, m.bbox.x + m.bbox.w);
    y2 = Math.max(y2, m.bbox.y + m.bbox.h);
  }
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/**
 * Score a cluster on how likely it is to be the listing media region.
 * Higher = better.
 *
 * Signals:
 *   - member count (more is better, plateaus around 5)
 *   - avg member score (photo-likeness)
 *   - position (top of page preferred)
 *   - has a hero-sized member (≥ 0.04 area)
 *   - composition: 1 dominant + N satellites (the "listing gallery" signature)
 *   - density (members fill cluster bbox, not scattered noise)
 *   - low avg textScore (cluster of text blocks should lose)
 *   - property_photo dominance (fraction of members classified as photos)
 *   - schematic penalty: if map+floorplan ≥ photo count, hard penalty
 */
export function scoreCluster(cluster) {
  const m = cluster.members;
  if (!m.length) return { score: -1e6, reasons: { empty: true } };

  const reasons = {};
  let score = 0;

  // 1. Member count (gallery clusters usually have 3-6 members)
  if (m.length >= 3) { score += 35; reasons.manyMembers = +35; }
  else if (m.length === 2) { score += 15; reasons.pairMembers = +15; }
  else { score += 0; reasons.singleton = 0; }

  // 2. Average photo-score of members
  const avgScore = m.reduce((s, c) => s + (c.score ?? 0), 0) / m.length;
  if (avgScore >= 60) { score += 30; reasons.strongAvg = +30; }
  else if (avgScore >= 30) { score += 15; reasons.okAvg = +15; }
  else if (avgScore < 0) { score -= 20; reasons.weakAvg = -20; }

  // 3. Vertical position — galleries live up top
  const cy = cluster.bbox.y + cluster.bbox.h / 2;
  if (cy < 0.3) { score += 30; reasons.topCluster = +30; }
  else if (cy < 0.5) { score += 15; reasons.upperCluster = +15; }
  else if (cy > 0.7) { score -= 25; reasons.bottomCluster = -25; }

  // 4. Has at least one hero-sized photo
  const hasHero = m.some((c) => area(c.bbox) >= 0.04);
  if (hasHero) { score += 25; reasons.hasHero = +25; }

  // 4b. Composition bonus — "1 dominant + N satellites" is the listing-
  //     gallery signature. A real estate hero cluster has one big photo
  //     (hero) and several smaller ones (thumbnails). A right-side
  //     thumbnail strip alone has many similar-size members; bumping
  //     composition-bearing clusters lets the hero+thumbs layout win over
  //     dense-but-flat thumbnail strips. spinstr108.
  let composition = 0;
  if (m.length >= 2) {
    const areas = m.map((c) => area(c.bbox)).sort((a, b) => b - a);
    const largest = areas[0];
    const secondLargest = areas[1];
    // Dominant member is substantially bigger than the rest.
    if (largest >= 0.04 && largest >= secondLargest * 2 && m.length >= 3) {
      composition = 40;
      reasons.heroPlusSatellites = +40;
    } else if (largest >= 0.04 && largest >= secondLargest * 2) {
      composition = 25;
      reasons.heroPlusPair = +25;
    }
  }
  if (!hasHero) {
    // No member reaches hero size — cluster is a thumbnail strip or
    // sidebar grid. Still usable as gallery but not the primary target.
    score -= 15;
    reasons.noDominant = -15;
  }
  score += composition;

  // 5. Density — sum of member areas / cluster bbox area. Tight galleries
  //    score ≥ 0.5; scattered noise < 0.2.
  const memberArea = m.reduce((s, c) => s + area(c.bbox), 0);
  const bboxArea = Math.max(1e-6, area(cluster.bbox));
  const density = memberArea / bboxArea;
  if (density >= 0.5) { score += 20; reasons.denseCluster = +20; }
  else if (density >= 0.3) { score += 10; reasons.okDensity = +10; }
  else if (density < 0.15) { score -= 15; reasons.sparseCluster = -15; }

  // 6. Low text/UI density on average — if cluster members are mostly
  //    text blocks, it's a sidebar not a gallery.
  const avgText = m.reduce((s, c) => s + (c.stats?.textScore ?? 0), 0) / m.length;
  if (avgText < 0.15) { score += 15; reasons.smoothCluster = +15; }
  else if (avgText > 0.4) { score -= 25; reasons.textyCluster = -25; }

  // 7. Property-photo dominance
  const photoCount = m.filter((c) => c.mediaType === "property_photo").length;
  const schematicCount = m.filter(
    (c) => c.mediaType === "floorplan" || c.mediaType === "map",
  ).length;
  const photoFrac = photoCount / m.length;
  if (photoFrac >= 0.8) { score += 25; reasons.photoCluster = +25; }
  else if (photoFrac >= 0.5) { score += 10; reasons.mixedPhotos = +10; }
  else if (photoFrac < 0.3) { score -= 20; reasons.nonPhotoCluster = -20; }

  // 7b. Schematic-dominance hard penalty (spinstr108 #5). If the cluster
  //     has as many (or more) map/floorplan members than photos, it's
  //     almost certainly a "listing detail" side panel rather than the
  //     media gallery.
  if (schematicCount > 0 && schematicCount >= photoCount) {
    score -= 60;
    reasons.schematicHeavy = -60;
  }

  return {
    score,
    reasons,
    avgScore,
    avgText,
    density,
    photoFrac,
    hasHero,
    composition,
    size: m.length,
  };
}

/**
 * If the dominant hero (the largest property_photo in the whole screenshot)
 * ended up in a singleton cluster next to a photo-rich "satellite" cluster,
 * merge them. This fixes the split-layout failure mode where a desktop
 * listing page shows the hero on the left and a thumbnail column on the
 * right with a visible gap — proximity clustering alone leaves them apart
 * and the denser right-side cluster wins, losing the hero entirely.
 *
 * Merge rules:
 *   - Hero's cluster must be "sparse" (1-2 members).
 *   - The candidate satellite cluster must have ≥ 2 property_photo members.
 *   - Horizontal gap between hero and satellite bboxes ≤ mergeMaxGapX.
 *   - Vertical overlap between hero and satellite spans ≥ verticalOverlapMin.
 *
 * Returns { clusters, merged: boolean, heroClusterIdx, satelliteIdx }.
 */
function mergeHeroWithSatellites(clusters, dominantHero, opts = {}) {
  if (!dominantHero) return { clusters, merged: false };
  const mergeMaxGapX = opts.mergeMaxGapX ?? 0.35;
  const mergeMaxGapY = opts.mergeMaxGapY ?? 0.15;
  const verticalOverlapMin = opts.verticalOverlapMin ?? 0.3;

  // Find the cluster that currently contains the hero.
  let heroClusterIdx = -1;
  for (let i = 0; i < clusters.length; i += 1) {
    if (clusters[i].members.includes(dominantHero)) {
      heroClusterIdx = i;
      break;
    }
  }
  if (heroClusterIdx < 0) return { clusters, merged: false };

  const heroCluster = clusters[heroClusterIdx];
  // Already part of a gallery-sized cluster — nothing to do.
  if (heroCluster.members.length >= 3) {
    return { clusters, merged: false, heroClusterIdx };
  }

  // Look for a photo-rich satellite.
  const heroB = dominantHero.bbox;
  const heroY1 = heroB.y;
  const heroY2 = heroB.y + heroB.h;
  const heroX1 = heroB.x;
  const heroX2 = heroB.x + heroB.w;
  const heroVSpan = Math.max(1e-6, heroY2 - heroY1);

  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < clusters.length; i += 1) {
    if (i === heroClusterIdx) continue;
    const c = clusters[i];
    const photoMembers = c.members.filter((m) => m.mediaType === "property_photo");
    if (photoMembers.length < 2) continue;

    // Gap along each axis between hero bbox and cluster bbox.
    const cb = c.bbox;
    const gapX = Math.max(0, Math.max(heroX1, cb.x) - Math.min(heroX2, cb.x + cb.w));
    const gapY = Math.max(0, Math.max(heroY1, cb.y) - Math.min(heroY2, cb.y + cb.h));
    if (gapX > mergeMaxGapX || gapY > mergeMaxGapY) continue;

    // Vertical overlap: how much of the hero's vertical span is covered
    // by the cluster's vertical span. A thumbnail strip beside the hero
    // sits at roughly the same Y range.
    const overlapY = Math.max(
      0,
      Math.min(heroY2, cb.y + cb.h) - Math.max(heroY1, cb.y),
    );
    const overlapFrac = overlapY / heroVSpan;
    if (overlapFrac < verticalOverlapMin) continue;

    // Score candidates by proximity — prefer the closest qualifying cluster.
    const centerDist = Math.hypot(
      (cb.x + cb.w / 2) - (heroX1 + heroB.w / 2),
      (cb.y + cb.h / 2) - (heroY1 + heroB.h / 2),
    );
    if (centerDist < bestDist) {
      bestDist = centerDist;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) return { clusters, merged: false, heroClusterIdx };

  // Merge: union members, recompute bbox, drop the satellite cluster.
  const satellite = clusters[bestIdx];
  const mergedMembers = [...heroCluster.members, ...satellite.members];
  const merged = { members: mergedMembers, bbox: clusterBbox(mergedMembers) };
  const out = clusters
    .map((c, i) => (i === heroClusterIdx ? merged : c))
    .filter((_, i) => i !== bestIdx);
  return {
    clusters: out,
    merged: true,
    heroClusterIdx,
    satelliteIdx: bestIdx,
    heroClusterSize: heroCluster.members.length,
    satelliteSize: satellite.members.length,
  };
}

/**
 * Pick the best cluster from scored candidates. Returns the chosen cluster
 * (or null when no candidate is viable).
 *
 * Contract: we prefer multi-member photo clusters, but if only single-
 * member clusters exist we still return the best one so the pipeline can
 * fall back to individual scoring gracefully.
 *
 * spinstr108 — handles split layouts (hero separated from thumbnail strip)
 * by locating the dominant hero (largest property_photo) and merging it
 * into the nearest photo-rich satellite cluster when appropriate.
 */
export function pickBestCluster(candidates, opts = {}) {
  const clusters = buildClusters(candidates, opts);

  // Find the dominant hero = largest-area property_photo across the whole
  // input set. This is the "correct hero" per spinstr108 #1.
  const photoCandidates = candidates.filter((c) => c.mediaType === "property_photo");
  const dominantHero = photoCandidates.length > 0
    ? photoCandidates.reduce((best, c) =>
        area(c.bbox) > area(best.bbox) ? c : best,
      )
    : null;

  // Merge hero with a nearby satellite cluster if the initial clustering
  // separated them (common on desktop listing pages with hero-on-left +
  // thumbnails-on-right layouts).
  const mergeInfo = mergeHeroWithSatellites(clusters, dominantHero, opts);

  const evaluated = mergeInfo.clusters.map((c) => ({
    ...c,
    ...scoreCluster(c),
  }));
  evaluated.sort((a, b) => b.score - a.score);

  return {
    chosen: evaluated[0] ?? null,
    clusters: evaluated,
    dominantHero,
    mergeInfo,
  };
}
