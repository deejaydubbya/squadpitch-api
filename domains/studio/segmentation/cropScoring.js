// Per-segment scoring for the SAM 2 post-processing pipeline.
//
// SAM 2 is agnostic — it masks "things", including ads, UI chrome, nav
// panels and flat color blocks. This module inspects the actual pixels
// inside each bbox and scores how "photo-like" the segment is, so the
// ranker can pick real gallery images over ads / banners / UI.
//
// Key signals (from sharp's `.stats()` + geometry):
//   - per-channel stdev → color variance (photos have high, flat blocks low)
//   - entropy           → information density (photos ~6-8, ads/solid ~0-4)
//   - color range       → difference between R/G/B means (grayscale text = low)
//   - aspect ratio      → photos cluster near 0.75 - 2.0
//   - position          → RE galleries live in the top ~40% of the page
//   - size              → meaningful coverage, not full-page or pinhole

import sharp from "sharp";

/**
 * Detect the bounding box of the "main content" inside a screenshot by
 * trimming nearly-solid-color margins (black desktop viewer chrome, gray
 * letterboxing, white padding). Returns normalized bbox {x,y,w,h} against
 * the original image; callers translate SAM bboxes back using this offset.
 *
 * Heuristic:
 *   1. Downsample to a thin column + row profile (grayscale stdev per strip)
 *   2. Rows/cols with near-zero stdev = solid margin
 *   3. Trim until stdev rises above noise threshold
 *
 * If no margins are detected (stdev rises immediately), returns the full
 * image (1×1 bbox) so the pipeline is unchanged.
 */
export async function detectContentRegion(sourceBuf) {
  if (!sourceBuf) return { x: 0, y: 0, w: 1, h: 1 };
  try {
    const meta = await sharp(sourceBuf).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return { x: 0, y: 0, w: 1, h: 1 };

    // 1. Column strip (height = H, width = 1): per-row stdev estimate via
    //    luminance vs a blurred baseline.
    const stripW = Math.min(W, 200);
    const stripH = Math.min(H, 400);
    const { data: colData } = await sharp(sourceBuf)
      .resize(stripW, stripH, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Compute per-row variance across the width. Solid margins have low variance.
    const rowVar = new Array(stripH).fill(0);
    for (let y = 0; y < stripH; y++) {
      let min = 255;
      let max = 0;
      for (let x = 0; x < stripW; x++) {
        const v = colData[y * stripW + x];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      rowVar[y] = max - min;
    }
    // Per-column variance across height.
    const colVar = new Array(stripW).fill(0);
    for (let x = 0; x < stripW; x++) {
      let min = 255;
      let max = 0;
      for (let y = 0; y < stripH; y++) {
        const v = colData[y * stripW + x];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      colVar[x] = max - min;
    }

    // Threshold — anything below 15 luminance range is a solid margin.
    const THR = 15;
    let top = 0;
    while (top < stripH && rowVar[top] < THR) top++;
    let bottom = stripH - 1;
    while (bottom > top && rowVar[bottom] < THR) bottom--;
    let left = 0;
    while (left < stripW && colVar[left] < THR) left++;
    let right = stripW - 1;
    while (right > left && colVar[right] < THR) right--;

    // If trimming eats too much, abort and use full image (safer).
    const trimmedW = right - left + 1;
    const trimmedH = bottom - top + 1;
    if (trimmedW < stripW * 0.4 || trimmedH < stripH * 0.4) {
      return { x: 0, y: 0, w: 1, h: 1 };
    }
    // If trim is negligible (< 2% per side), skip.
    const marginPctX = (left + (stripW - 1 - right)) / stripW;
    const marginPctY = (top + (stripH - 1 - bottom)) / stripH;
    if (marginPctX < 0.02 && marginPctY < 0.02) {
      return { x: 0, y: 0, w: 1, h: 1 };
    }

    return {
      x: left / stripW,
      y: top / stripH,
      w: trimmedW / stripW,
      h: trimmedH / stripH,
    };
  } catch {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
}

/** Fetch a source image (data URL or http/https) into a Buffer, once. */
export async function fetchSourceBuffer(imageUrl) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("data:")) {
    const comma = imageUrl.indexOf(",");
    if (comma < 0) return null;
    return Buffer.from(imageUrl.slice(comma + 1), "base64");
  }
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Compute a cheap text/UI-density signal for a crop.
 *
 * The intuition: entropy alone can't distinguish text from photos — both
 * have high information density. But text/UI has *structure*:
 *
 *   - Text rows create regular vertical banding (dark chars ↔ light gaps
 *     between lines). Reduced to a 1-pixel-wide column, this shows up as
 *     high row-to-row luminance delta: transitionY ≈ 0.25..0.6.
 *   - Chip rows / pipe-separated filter strips ("3 bd • 2 ba • 1,800 sqft")
 *     create regular horizontal banding. Reduced to a 1-pixel-high row, this
 *     shows up as high col-to-col delta: transitionX ≈ 0.2..0.5.
 *   - Photos produce smooth gradients in both directions: transitionX/Y
 *     typically < 0.12.
 *
 * We combine both axes into a `textScore` in [0,1] where higher = more
 * text/UI-like. Two cheap sharp passes (resize→raw bytes) per crop.
 */
async function computeTextDensity(sourceBuf, rect) {
  const { left, top, width, height } = rect;
  if (width < 16 || height < 16) return null;
  try {
    // 1. Vertical profile: downsample to a 1-pixel-wide column.
    const base = sharp(sourceBuf).extract({ left, top, width, height });
    const rowsH = Math.min(height, 200);
    const { data: colData } = await base
      .clone()
      .resize(1, rowsH, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let transitionsY = 0;
    for (let i = 1; i < rowsH; i++) {
      if (Math.abs(colData[i] - colData[i - 1]) > 18) transitionsY++;
    }
    const transitionY = transitionsY / Math.max(1, rowsH - 1);

    // 2. Horizontal profile: downsample to a 1-pixel-high row.
    const colsW = Math.min(width, 300);
    const { data: rowData } = await base
      .clone()
      .resize(colsW, 1, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let transitionsX = 0;
    for (let i = 1; i < colsW; i++) {
      if (Math.abs(rowData[i] - rowData[i - 1]) > 18) transitionsX++;
    }
    const transitionX = transitionsX / Math.max(1, colsW - 1);

    // Combined score: weight whichever axis is more "bumpy".
    // Text rows → transitionY dominates. Chip rows → transitionX dominates.
    // Photos → both low.
    const textScore = Math.max(transitionY * 1.2, transitionX);

    return { transitionX, transitionY, textScore };
  } catch {
    return null;
  }
}

/**
 * Compute pixel-level stats for a single normalized bbox against a shared
 * source buffer. Returns `null` if the crop is invalid or sharp fails.
 */
export async function computeCropStats(sourceBuf, bbox, srcW, srcH) {
  if (!sourceBuf || !srcW || !srcH) return null;
  // Convert normalized bbox → pixel rect, clamped inside the image.
  const left = Math.max(0, Math.min(srcW - 1, Math.round(bbox.x * srcW)));
  const top = Math.max(0, Math.min(srcH - 1, Math.round(bbox.y * srcH)));
  const width = Math.max(1, Math.min(srcW - left, Math.round(bbox.w * srcW)));
  const height = Math.max(1, Math.min(srcH - top, Math.round(bbox.h * srcH)));
  if (width < 4 || height < 4) return null;

  try {
    const pipeline = sharp(sourceBuf).extract({ left, top, width, height });
    const stats = await pipeline.stats();
    const ch = stats.channels ?? [];
    const r = ch[0] ?? { mean: 0, stdev: 0 };
    const g = ch[1] ?? r;
    const b = ch[2] ?? r;
    const avgStdev = (r.stdev + g.stdev + b.stdev) / 3;
    const means = [r.mean, g.mean, b.mean];
    const colorRange = Math.max(...means) - Math.min(...means);
    const dominant = stats.dominant ?? { r: 0, g: 0, b: 0 };
    // sharp exposes top-level `entropy` (shannon bits, 0..8)
    const entropy = typeof stats.entropy === "number" ? stats.entropy : 0;
    // Rough luminance of the dominant color — near-white / near-black blocks
    // strongly suggest UI chrome (search bars, nav strips, footers).
    const domLum =
      0.2126 * dominant.r + 0.7152 * dominant.g + 0.0722 * dominant.b;

    // Text/UI density — horizontal & vertical banding signature.
    const textDensity = await computeTextDensity(sourceBuf, { left, top, width, height });

    return {
      stdev: avgStdev,
      entropy,
      colorRange,
      dominant,
      domLum,
      pxWidth: width,
      pxHeight: height,
      transitionX: textDensity?.transitionX ?? 0,
      transitionY: textDensity?.transitionY ?? 0,
      textScore: textDensity?.textScore ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Classify a candidate's visual type using pixel stats + geometry. Returns
 * one of: "property_photo", "floorplan", "map", "ui", "ad", "unknown".
 *
 * Cheap heuristic classifier — it's only called on candidates that already
 * passed hard-reject, so obvious UI/flat panels are gone. The goal is to
 * separate property photos from schematic content (floorplans, maps) so
 * we can exclude them from default selection.
 */
export function classifyMedia({ bbox, stats }) {
  if (!stats) return "unknown";
  const { stdev, entropy, colorRange, domLum, textScore = 0 } = stats;
  const { dominant = { r: 0, g: 0, b: 0 } } = stats;
  const ar = bbox.w / Math.max(1e-6, bbox.h);

  // UI signature: moderate-to-heavy text density without photo-like variance.
  //   - textScore between 0.25 and 0.55 (survived hard reject's 0.55 cap)
  //   - low-to-moderate color variance
  //   - often has a flat dominant color (nav bar, toolbar)
  // These usually ARE hard-rejected upstream, but some chip rows / sidebars
  // slip through with textScore around 0.3-0.5.
  if (textScore >= 0.3 && stdev < 45 && colorRange < 35) {
    return "ui";
  }

  // Ad signature: we see three common shapes in listing screenshots —
  //   a. wide-and-short banners (728x90-style) — high aspect, mid-entropy
  //   b. small saturated tile promos (sidebar boxes)
  //   c. LARGE food/product/promo images (spinstr109) — these slip past
  //      property_photo because they have high entropy AND high stdev,
  //      but the GIVEAWAY is heavily-saturated dominant color paired with
  //      a mid-range color range: real estate hero photos have either
  //      a neutral palette (walls, sky) OR complex mixed palette, while
  //      product/food ads have one dominant hue swamping everything.
  const isBannerAspect = ar > 3.2 && entropy >= 4 && entropy < 7;
  const isSmallSaturatedPromo =
    colorRange >= 50 && entropy < 6 && stdev < 55 && bbox.w * bbox.h < 0.08;
  // Dominant saturation: if one channel dominates by a wide margin AND
  // the dominant color itself is vivid (not a neutral wall), it's almost
  // certainly a promo image rather than a real-estate photo. Real-estate
  // exteriors have sky (neutral/blue-low-saturation) + structure; interiors
  // have neutral/warm walls. Food/product ads have a dominant hue.
  const domMax = Math.max(dominant.r, dominant.g, dominant.b);
  const domMin = Math.min(dominant.r, dominant.g, dominant.b);
  const domSaturation = domMax > 0 ? (domMax - domMin) / domMax : 0;
  const isVividPromo =
    domSaturation > 0.45 &&
    colorRange >= 45 &&
    entropy < 7.2 &&
    // guard: real estate exteriors with strong blue sky can hit ~0.45
    // saturation — require the dominant NOT be a blue/neutral sky tone.
    !(dominant.b > dominant.r + 15 && dominant.b > 170);
  if (isBannerAspect || isSmallSaturatedPromo || isVividPromo) {
    return "ad";
  }

  // Floorplan signature: near-white background, very low color variance,
  // thin dark lines, often some text labels. Strongly monochrome.
  //   - domLum > 220 (white-ish background)
  //   - colorRange < 20 (grayscale)
  //   - stdev in 15..45 (lines create some variance but not photo-like)
  //   - NOT pure UI (textScore < 0.5)
  if (
    domLum > 218 &&
    colorRange < 22 &&
    stdev >= 12 &&
    stdev < 55 &&
    textScore < 0.55
  ) {
    return "floorplan";
  }

  // Map signature: moderate entropy, MID-range dominant lightness (not
  // white, not dark), and a very specific color palette — maps tend to
  // be pastel tan/green/blue with LOW saturation overall AND labels.
  //   - dominant colors in the "map palette" range (muted tan/green/blue)
  //   - mid-range domLum (160..215 — not pure white, not dark)
  //   - some text (labels) but not high-text
  //   - colorRange low-to-moderate (< 30) because map hues are pastel
  const isMapTan = dominant.r > 180 && dominant.g > 170 && dominant.b < dominant.r - 10 && dominant.b < 200;
  const isMapGreen = dominant.g > dominant.r + 8 && dominant.g > dominant.b + 8 && dominant.g > 150;
  const isMapBlue = dominant.b > dominant.r + 15 && dominant.b > 170;
  const mapPalette = isMapTan || isMapGreen || isMapBlue;
  if (
    mapPalette &&
    domLum > 150 &&
    domLum < 225 &&
    entropy >= 4.5 &&
    entropy < 7.2 &&
    textScore >= 0.18 &&
    textScore < 0.55 &&
    colorRange < 40
  ) {
    return "map";
  }

  // Otherwise, treat as a property photo.
  return "property_photo";
}

/**
 * Hard reject rules — anything returning non-null is dropped before scoring.
 * String value is logged to debug.rejected[].
 */
export function hardReject({ bbox, stats }) {
  const ar = bbox.w / Math.max(1e-6, bbox.h);
  const areaN = bbox.w * bbox.h;
  const cy = bbox.y + bbox.h / 2;

  // Geometry — only reject truly-broken shapes. Position-based rejects
  // moved into the scoring pass so we always have *some* survivors to rank
  // (even on scrolled screenshots where the photos sit mid-page).
  if (bbox.w < 0.035 || bbox.h < 0.035) return "too_small";
  if (areaN < 0.003) return "tiny_area";
  if (bbox.w >= 0.95 && bbox.h >= 0.95) return "entire_page";
  // Full-width thin strips = page header / banner ad / nav bar
  if (bbox.w >= 0.88 && bbox.h < 0.07) return "full_width_thin";
  if (ar < 0.28) return "too_tall";
  // Wide rectangles can be: (a) promo banners / nav strips (correctly rejected),
  // or (b) legitimate hero/panorama slices from SAM fragmenting a large photo.
  // Don't reject purely on aspect — require lack of photo signals.
  // spinstr111: the real exterior was being lost here when SAM split it into
  // thin wide slices that were then marked `extreme_banner`.
  if (ar > 5.0) {
    const hasPhotoSignals =
      stats && stats.stdev >= 28 && stats.entropy >= 5.5 &&
      (stats.textScore ?? 0) < 0.35;
    // Absolute cap: nothing over 9.0 is ever a photo.
    if (!hasPhotoSignals || ar > 9.0) return "extreme_banner";
  }

  // Pixel content
  if (stats) {
    // Flat color block (ads, backgrounds, solid UI panels)
    if (stats.stdev < 8) return "flat_color";
    // Near-white blocks with low entropy → search bars, empty panels
    if (stats.domLum > 235 && stats.entropy < 4) return "white_ui_panel";
    // Near-black panels with tiny variance
    if (stats.domLum < 20 && stats.stdev < 18) return "black_ui_panel";
    // Dense text / chip-row / filter-strip UI. The textScore combines both
    // axes so this catches BOTH paragraphs of text AND horizontal chip rows
    // (e.g. "3bd • 2ba • 1,800 sqft" strips). High bar — photos occasionally
    // score ~0.4 on fine detail, so only reject clear outliers.
    if (stats.textScore > 0.55) return "text_heavy";
    // Horizontal chip rows (wide-and-short + high col transitions): the
    // aspect ratio + transitionX combo is a reliable filter-strip signature.
    if (ar > 2.8 && stats.transitionX > 0.4) return "chip_row";
  }

  return null;
}

/**
 * Score a candidate that survived hard filtering. Higher = more photo-like,
 * more likely to be a real-estate gallery image.
 *
 * Returns `{ score, reasons }` where reasons is a map of contribution → delta
 * for the debug overlay.
 */
export function scoreSegment({ bbox, stats }) {
  const reasons = {};
  let score = 0;

  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const ar = bbox.w / Math.max(1e-6, bbox.h);
  const areaN = bbox.w * bbox.h;

  // --- Position (top-of-page priority; spec step 4) ---
  // Real-estate galleries almost always live in y < 0.3. Anything below 0.5
  // is essentially never a hero photo. We weight this aggressively because
  // the *single* cheapest way to avoid selecting sidebar ads / info panels
  // is to just rule out the bottom half.
  if (cy < 0.15) { score += 55; reasons.topOfPage = +55; }
  else if (cy < 0.25) { score += 45; reasons.upperTop = +45; }
  else if (cy < 0.35) { score += 25; reasons.upperThird = +25; }
  else if (cy < 0.5) { score += 0; }
  else if (cy < 0.65) { score -= 30; reasons.lowerHalf = -30; }
  else { score -= 55; reasons.bottom = -55; }

  // --- Sidebar penalty ---
  // Right sidebars (schedule-a-tour, map, ads) center around cx > 0.72.
  // If the center is way right AND below the top banner zone, it's almost
  // certainly sidebar chrome.
  if (cx > 0.78) { score -= 35; reasons.rightSidebar = -35; }
  else if (cx > 0.72 && cy > 0.1) { score -= 20; reasons.partialSidebar = -20; }
  // Centered main-column bonus
  else if (cx > 0.12 && cx < 0.7) { score += 10; reasons.centerColumn = +10; }

  // --- Aspect ratio ---
  // RE hero photos are often 2.2-3.2 wide (landscape). Reward broadly.
  if (ar >= 1.2 && ar <= 1.9) { score += 28; reasons.heroAspect = +28; }
  else if (ar >= 0.75 && ar <= 2.6) { score += 22; reasons.photoAspect = +22; }
  else if (ar >= 0.5 && ar <= 3.3) { score += 10; reasons.okAspect = +10; }
  else if (ar > 3.6) { score -= 25; reasons.bannerAspect = -25; }
  else if (ar < 0.42) { score -= 18; reasons.narrowAspect = -18; }

  // --- Size / area ---
  // Hero ~0.08-0.3, tiles ~0.005-0.03 are both common in RE screenshots.
  if (areaN >= 0.08 && areaN <= 0.35) { score += 25; reasons.heroSize = +25; }
  else if (areaN >= 0.03 && areaN < 0.08) { score += 15; reasons.mediumSize = +15; }
  else if (areaN >= 0.006 && areaN < 0.03) { score += 8; reasons.tileSize = +8; }
  else if (areaN < 0.004) { score -= 20; reasons.tinySize = -20; }
  else if (areaN > 0.5) { score -= 15; reasons.tooLarge = -15; }

  // --- Pixel-level photo-likeness ---
  if (stats) {
    // Stdev — photos have wide tonal range
    if (stats.stdev >= 45) { score += 25; reasons.highVariance = +25; }
    else if (stats.stdev >= 28) { score += 12; reasons.mediumVariance = +12; }
    else if (stats.stdev < 15) { score -= 25; reasons.lowVariance = -25; }

    // Entropy — photos are information-rich
    if (stats.entropy >= 6.5) { score += 20; reasons.highEntropy = +20; }
    else if (stats.entropy >= 5.5) { score += 10; reasons.okEntropy = +10; }
    else if (stats.entropy < 4) { score -= 18; reasons.lowEntropy = -18; }

    // Color range — grayscale/monochrome blocks are usually text/UI
    if (stats.colorRange >= 25) { score += 10; reasons.colorful = +10; }
    else if (stats.colorRange < 6) { score -= 12; reasons.monochrome = -12; }

    // Penalise near-white mid-size blocks (likely text cards / info panels /
    // calendar-picker tour forms with lots of empty background).
    if (stats.domLum > 215 && stats.entropy < 6 && areaN < 0.25) {
      score -= 22;
      reasons.lightUiBlock = -22;
    }

    // --- Text/UI density (graded) ---
    // Anything >0.55 was already hard-rejected as text_heavy, so here we only
    // see mild-to-moderate text/UI signatures. Still penalise heavily — the
    // spinstr104 failure mode is specifically sidebar/filter widgets that
    // score "photo-like" on entropy+stdev but have visible text structure.
    const ts = stats.textScore ?? 0;
    if (ts > 0.45) { score -= 35; reasons.textDense = -35; }
    else if (ts > 0.35) { score -= 22; reasons.textModerate = -22; }
    else if (ts > 0.25) { score -= 10; reasons.textMild = -10; }
    else if (ts < 0.12) { score += 8; reasons.smoothPhoto = +8; }

    // Horizontal chip rows that slipped past hard reject (slightly narrower
    // than 2.8 aspect, or transitionX in the 0.3-0.4 range).
    if ((stats.transitionX ?? 0) > 0.3 && ar > 2.0) {
      score -= 15;
      reasons.chipish = -15;
    }
  }

  return { score, reasons };
}
