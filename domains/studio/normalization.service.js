import { prisma } from '../../prisma.js';
import { classifyContent } from './classification.service.js';

// ── Platform-Specific Normalization ───────────────────────────────────

const PLATFORM_RULES = {
  INSTAGRAM: (d) => {
    const engagements = (d.likes ?? 0) + (d.comments ?? 0) + (d.saves ?? 0);
    const base = d.impressions || d.reach || 0;
    return {
      impressions: d.impressions ?? null,
      reach: d.reach ?? null,
      engagements,
      clicks: d.clicks ?? null,
      engagementRate: base > 0 ? engagements / base : null,
    };
  },
  TIKTOK: (d) => {
    const engagements = (d.likes ?? 0) + (d.comments ?? 0) + (d.shares ?? 0);
    const base = d.views || 0;
    return {
      impressions: d.views ?? null,
      reach: d.reach ?? null,
      engagements,
      clicks: d.clicks ?? null,
      engagementRate: base > 0 ? engagements / base : null,
    };
  },
  LINKEDIN: (d) => {
    const engagements = (d.reactions ?? 0) + (d.comments ?? 0) + (d.reposts ?? 0);
    const base = d.impressions || 0;
    return {
      impressions: d.impressions ?? null,
      reach: d.reach ?? null,
      engagements,
      clicks: d.clicks ?? null,
      engagementRate: base > 0 ? engagements / base : null,
    };
  },
  X: (d) => {
    const engagements = (d.likes ?? 0) + (d.retweets ?? 0) + (d.replies ?? 0);
    const base = d.impressions || 0;
    return {
      impressions: d.impressions ?? null,
      reach: d.reach ?? null,
      engagements,
      clicks: d.clicks ?? null,
      engagementRate: base > 0 ? engagements / base : null,
    };
  },
  FACEBOOK: (d) => {
    const engagements = (d.reactions ?? 0) + (d.comments ?? 0) + (d.shares ?? 0);
    const base = d.impressions || d.reach || 0;
    return {
      impressions: d.impressions ?? null,
      reach: d.reach ?? null,
      engagements,
      clicks: d.clicks ?? null,
      engagementRate: base > 0 ? engagements / base : null,
    };
  },
  YOUTUBE: (d) => {
    const engagements = (d.likes ?? 0) + (d.comments ?? 0) + (d.shares ?? 0);
    const base = d.views || 0;
    return {
      impressions: d.views ?? null,
      reach: d.reach ?? null,
      engagements,
      clicks: d.clicks ?? null,
      engagementRate: base > 0 ? engagements / base : null,
    };
  },
};

export function normalizeRawMetrics(channel, rawDataJson) {
  const normalizer = PLATFORM_RULES[channel];
  if (!normalizer) return { impressions: null, reach: null, engagements: null, clicks: null, engagementRate: null };
  return normalizer(rawDataJson);
}

// ── Relative Engagement Rate ──────────────────────────────────────────

export async function calculateRelativeEngagementRate(clientId, channel, engagementRate) {
  if (engagementRate == null) return 1.0;

  const stats = await prisma.normalizedMetric.aggregate({
    where: { clientId, channel },
    _avg: { engagementRate: true },
    _count: true,
  });

  if (!stats._count || !stats._avg.engagementRate) return 1.0;
  return engagementRate / stats._avg.engagementRate;
}

// ── Internal Signals (no platform data needed) ────────────────────────

const CTA_KEYWORDS = ['link in bio', 'click', 'sign up', 'subscribe', 'download', 'shop', 'buy', 'join', 'learn more', 'get started', 'dm me', 'comment below'];
const HOOK_PATTERNS = [/^\?|^how |^why |^what |^when |^where |^who /i, /^\d+\s/, /^did you know/i, /^stop /i, /^imagine /i];

const PLATFORM_IDEAL_LENGTH = {
  INSTAGRAM: { min: 100, max: 2200 },
  TIKTOK: { min: 50, max: 300 },
  X: { min: 50, max: 280 },
  LINKEDIN: { min: 150, max: 3000 },
  FACEBOOK: { min: 100, max: 500 },
  YOUTUBE: { min: 200, max: 5000 },
};

export function extractInternalSignals(draft) {
  const body = draft.body || '';
  const bodyLen = body.length;

  // Body length score (0-25)
  let bodyScore = 10;
  if (bodyLen >= 100 && bodyLen <= 500) bodyScore = 20;
  else if (bodyLen > 500) bodyScore = 25;

  // Media presence (0-25)
  let mediaScore = 0;
  const mt = (draft.mediaType || '').toLowerCase();
  if (mt.includes('video')) mediaScore = 25;
  else if (mt.includes('image') || draft.mediaUrl) mediaScore = 20;

  // CTA present (0-15)
  const hasCta = draft.cta || CTA_KEYWORDS.some((kw) => body.toLowerCase().includes(kw));
  const ctaScore = hasCta ? 15 : 0;

  // Hooks present (0-15)
  const hookCount = (draft.hooks || []).length;
  let hookScore = 0;
  if (hookCount >= 3) hookScore = 15;
  else if (hookCount >= 1) hookScore = 10;

  // Hashtags present (0-10)
  const hasHashtags = (draft.hashtags || []).length > 0;
  const hashtagScore = hasHashtags ? 10 : 0;

  // Platform-appropriate length (0-10)
  let lengthFitScore = 5;
  const ideal = PLATFORM_IDEAL_LENGTH[draft.channel];
  if (ideal && bodyLen >= ideal.min && bodyLen <= ideal.max) {
    lengthFitScore = 10;
  } else if (ideal && (bodyLen < ideal.min * 0.5 || bodyLen > ideal.max * 1.5)) {
    lengthFitScore = 0;
  }

  const completenessScore = bodyScore + mediaScore + ctaScore + hookScore + hashtagScore + lengthFitScore;

  return {
    completenessScore: Math.min(100, completenessScore),
    signals: { bodyScore, mediaScore, ctaScore, hookScore, hashtagScore, lengthFitScore },
  };
}

// ── Classify & Save Insight ───────────────────────────────────────────

const CONTENT_KEYWORDS = {
  educational: ['learn', 'tip', 'guide', 'how to', 'tutorial', 'step', 'lesson', 'explain', 'understand'],
  promotional: ['sale', 'offer', 'discount', 'buy', 'shop', 'deal', 'promo', 'launch', 'available now'],
  story: ['story', 'journey', 'experience', 'behind the scenes', 'day in', 'transformation'],
  engagement: ['comment', 'share', 'tag', 'poll', 'question', 'vote', 'thoughts', 'agree?', 'opinion'],
  announcement: ['announce', 'introducing', 'new', 'excited', 'reveal', 'coming soon', 'update'],
};

function inferContentType(body) {
  const lower = body.toLowerCase();
  let best = null;
  let bestCount = 0;
  for (const [type, keywords] of Object.entries(CONTENT_KEYWORDS)) {
    const count = keywords.filter((kw) => lower.includes(kw)).length;
    if (count > bestCount) { best = type; bestCount = count; }
  }
  return best || 'general';
}

function inferHookType(body) {
  const firstLine = (body || '').split('\n')[0] || '';
  if (/\?/.test(firstLine)) return 'question';
  if (/^how[\s-]/i.test(firstLine)) return 'how-to';
  if (/^\d+\s/.test(firstLine)) return 'list';
  return 'statement';
}

function getLengthBucket(body) {
  const len = (body || '').length;
  if (len < 100) return 'short';
  if (len <= 500) return 'medium';
  return 'long';
}

function getPostingTimeBucket(publishedAt) {
  if (!publishedAt) return null;
  const hour = new Date(publishedAt).getUTCHours();
  if (hour >= 5 && hour < 9) return 'morning';
  if (hour >= 9 && hour < 12) return 'midday';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

export async function computeAndSaveInsight(draft, normalizedMetric) {
  const { completenessScore } = extractInternalSignals(draft);

  let performanceScore = completenessScore;
  if (normalizedMetric?.relativeEngagementRate != null) {
    // Scale: relative rate * 50 (1.0 avg = 50, 2.0 = 100)
    performanceScore = Math.min(100, Math.round(normalizedMetric.relativeEngagementRate * 50));
  }

  const classification = classifyContent(draft);

  const data = {
    clientId: draft.clientId,
    performanceScore,
    contentType: classification.contentType,
    hookType: classification.hookType,
    lengthBucket: classification.lengthBucket,
    mediaType: classification.mediaType,
    postingTimeBucket: classification.postingTimeBucket,
    sentiment: classification.sentiment,
    recommendationTags: classification.recommendationTags,
  };

  return prisma.postInsight.upsert({
    where: { draftId: draft.id },
    create: { draftId: draft.id, ...data },
    update: data,
  });
}

// ── Backfill ──────────────────────────────────────────────────────────

export async function backfillClientInsights(clientId) {
  const drafts = await prisma.draft.findMany({
    where: {
      clientId,
      status: 'PUBLISHED',
      postInsight: null,
    },
    select: {
      id: true,
      clientId: true,
      body: true,
      channel: true,
      hooks: true,
      hashtags: true,
      cta: true,
      mediaUrl: true,
      mediaType: true,
      publishedAt: true,
    },
  });

  if (drafts.length === 0) return 0;

  let created = 0;
  for (const draft of drafts) {
    await computeAndSaveInsight(draft, null);
    created++;
  }
  return created;
}
