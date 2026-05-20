// Ads-10 — platform creative spec hints.
//
// Static, deliberately short, deliberately not authoritative. Each
// platform's exact specs shift constantly; the launch sheet just
// reminds the media buyer to verify in the platform's own UI.
// Update sparingly — this is a memory aid, not documentation.
//
// Add a new platform by extending the map below; renderers look
// up `PLATFORM_SPECS[descriptor.platform]` and fall back to
// `null` if there's no entry.

const META_SPEC = `
- **Square 1:1** (1080×1080) and **vertical 4:5** (1080×1350) work across
  Facebook + Instagram feeds.
- **Vertical 9:16** (1080×1920) for Stories / Reels placements.
- Max image size 30 MB; max video 4 GB / 240 min (Reels: 60 min).
- Verify current limits in Meta Ads Manager — they shift.
`.trim();

const TIKTOK_SPEC = `
- **Vertical 9:16** (1080×1920) video is the strong default for in-feed
  ads; horizontal/square accepted but downranked by the algorithm.
- Video: 9–60 sec sweet spot; max 60 sec for most placements.
- Hook + brand mention in the first 3 seconds materially impacts cost.
- Verify current limits in TikTok Ads Manager.
`.trim();

const LINKEDIN_SPEC = `
- **Single Image:** 1.91:1 landscape (1200×628) is the safest cross-
  placement default; square 1:1 (1200×1200) also accepted.
- **Video:** 16:9 landscape or 1:1 square; 3 sec–30 min, ≤200 MB.
- **Document Ad:** PDF up to 100 MB, up to 10 pages used in the feed.
- Verify current limits in LinkedIn Campaign Manager.
`.trim();

const PINTEREST_SPEC = `
- **Standard Pin:** vertical 2:3 (1000×1500) is the strong default —
  square or 1:1 underperforms in Pinterest's grid layout.
- **Idea Pin / Video Pin:** vertical 9:16 (1080×1920) preferred.
- Pinterest requires uploading the actual image/video file (URLs are
  not accepted as creative source).
- Verify current limits in Pinterest Ads Manager.
`.trim();

const GOOGLE_SPEC = `
- **Responsive Search Ads:** no image required; up to 15 headlines (30
  chars) + 4 descriptions (90 chars). Length warnings appear in the
  export response when SquadAds copy exceeds these limits.
- **Display campaigns:** 1.91:1 landscape (1200×628) + 1:1 square
  (1200×1200) cover most placements; Google's responsive display
  auto-resizes.
- **Performance Max:** asset groups need 5+ images, 5+ headlines,
  5+ descriptions, 1+ video. Use SquadAds variants as a starting set.
- Verify current limits inside Google Ads Editor / Ads UI.
`.trim();

const PLATFORM_SPECS = {
  meta: META_SPEC,
  tiktok: TIKTOK_SPEC,
  linkedin: LINKEDIN_SPEC,
  pinterest: PINTEREST_SPEC,
  google: GOOGLE_SPEC,
};

export function platformSpec(platform) {
  return PLATFORM_SPECS[platform] ?? null;
}
