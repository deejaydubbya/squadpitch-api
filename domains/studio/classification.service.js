import { prisma } from '../../prisma.js';

// ── Sentiment ────────────────────────────────────────────────────────

const POSITIVE_SIGNALS = ['excited', 'love', 'amazing', 'grateful', 'celebrate', 'thrilled', 'proud', 'incredible', 'fantastic', 'awesome'];
const NEGATIVE_SIGNALS = ['unfortunately', 'frustrated', 'disappointed', 'fail', 'sorry', 'terrible', 'awful', 'worst', 'mistake', 'regret'];

export function inferSentiment(body) {
  const lower = (body || '').toLowerCase();
  const pos = POSITIVE_SIGNALS.filter((w) => lower.includes(w)).length;
  const neg = NEGATIVE_SIGNALS.filter((w) => lower.includes(w)).length;
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

// ── Content Type ─────────────────────────────────────────────────────

const CONTENT_KEYWORDS = {
  educational: ['learn', 'tip', 'guide', 'how to', 'tutorial', 'step', 'lesson', 'explain', 'understand'],
  promotional: ['sale', 'offer', 'discount', 'buy', 'shop', 'deal', 'promo', 'launch', 'available now'],
  story: ['story', 'journey', 'experience', 'behind the scenes', 'day in', 'transformation'],
  engagement: ['comment', 'share', 'tag', 'poll', 'question', 'vote', 'thoughts', 'agree?', 'opinion'],
  announcement: ['announce', 'introducing', 'new', 'excited', 'reveal', 'coming soon', 'update'],
  community: ['community', 'tribe', 'shoutout', 'collab', 'spotlight', 'shout out', 'feature friday'],
};

function inferContentType(body) {
  const lower = (body || '').toLowerCase();
  let best = null;
  let bestCount = 0;
  for (const [type, keywords] of Object.entries(CONTENT_KEYWORDS)) {
    const count = keywords.filter((kw) => lower.includes(kw)).length;
    if (count > bestCount) { best = type; bestCount = count; }
  }
  return best || 'general';
}

// ── Hook Type ────────────────────────────────────────────────────────

function inferHookType(body) {
  const firstLine = (body || '').split('\n')[0] || '';
  const lower = firstLine.toLowerCase();

  // New expanded types first (more specific)
  if (/unpopular opinion|hot take|fight me|controversial/i.test(lower)) return 'controversial';
  if (/don'?t miss|last chance|limited time|ending soon|hurry/i.test(lower)) return 'urgency';
  if (/imagine|dream|believe|you can|anything is possible/i.test(lower)) return 'inspirational';
  if (/\bget\b|\bgrab\b|\bclaim\b|\bfree\b|% off|\bdiscount\b/i.test(lower)) return 'direct_offer';

  // Original types
  if (/\?/.test(firstLine)) return 'question';
  if (/^how[\s-]/i.test(firstLine)) return 'how-to';
  if (/^\d+\s/.test(firstLine)) return 'list';
  return 'statement';
}

// ── Length Bucket ─────────────────────────────────────────────────────

function getLengthBucket(body) {
  const len = (body || '').length;
  if (len < 100) return 'short';
  if (len <= 500) return 'medium';
  return 'long';
}

// ── Posting Time Bucket ──────────────────────────────────────────────

function getPostingTimeBucket(publishedAt) {
  if (!publishedAt) return null;
  const hour = new Date(publishedAt).getUTCHours();
  if (hour >= 5 && hour < 9) return 'morning';
  if (hour >= 9 && hour < 12) return 'midday';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

// ── Recommendation Tags ──────────────────────────────────────────────

const CTA_KEYWORDS = ['link in bio', 'click', 'sign up', 'subscribe', 'download', 'shop', 'buy', 'join', 'learn more', 'get started', 'dm me', 'comment below'];

function inferRecommendationTags(draft) {
  const tags = [];
  const body = draft.body || '';
  const bodyLen = body.length;

  // add-cta: no CTA detected
  const hasCta = draft.cta || CTA_KEYWORDS.some((kw) => body.toLowerCase().includes(kw));
  if (!hasCta) tags.push('add-cta');

  // add-visual: no media
  const mt = (draft.mediaType || '').toLowerCase();
  if (!mt.includes('video') && !mt.includes('image') && !draft.mediaUrl) tags.push('add-visual');

  // try-question-hook: statement hook and could benefit from question
  const hookType = inferHookType(body);
  if (hookType === 'statement') tags.push('try-question-hook');

  // shorten-copy / write-longer
  if (bodyLen > 1000) tags.push('shorten-copy');
  else if (bodyLen < 50 && bodyLen > 0) tags.push('write-longer');

  // add-hashtags: no hashtags present
  const hasHashtags = (draft.hashtags || []).length > 0 || /#\w/.test(body);
  if (!hasHashtags) tags.push('add-hashtags');

  return tags.slice(0, 5);
}

// ── Main Classification ──────────────────────────────────────────────

export function classifyContent(draft) {
  const body = draft.body || '';
  return {
    contentType: inferContentType(body),
    hookType: inferHookType(body),
    sentiment: inferSentiment(body),
    lengthBucket: getLengthBucket(body),
    mediaType: draft.mediaType || 'text',
    postingTimeBucket: getPostingTimeBucket(draft.publishedAt),
    recommendationTags: inferRecommendationTags(draft),
  };
}

// ── Backfill Sentiment + Tags on Existing Rows ───────────────────────

export async function reclassifyClientInsights(clientId) {
  const insights = await prisma.postInsight.findMany({
    where: { clientId, sentiment: null },
    select: { id: true, draftId: true },
  });

  if (insights.length === 0) return 0;

  let updated = 0;
  for (const insight of insights) {
    const draft = await prisma.draft.findUnique({
      where: { id: insight.draftId },
      select: { body: true, mediaType: true, mediaUrl: true, publishedAt: true, cta: true, hashtags: true },
    });
    if (!draft) continue;

    const { sentiment, recommendationTags } = classifyContent(draft);
    await prisma.postInsight.update({
      where: { id: insight.id },
      data: { sentiment, recommendationTags },
    });
    updated++;
  }
  return updated;
}
