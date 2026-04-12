// X (Twitter) metrics adapter.
//
// GET https://api.x.com/2/tweets/{id}?tweet.fields=public_metrics

export async function fetchXMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  const url =
    `https://api.x.com/2/tweets/${encodeURIComponent(externalPostId)}` +
    `?tweet.fields=public_metrics`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("X auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`X API ${res.status}`), { transient: true });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body?.detail ?? "X metrics failed"), { transient: true });
  }

  const metrics = body?.data?.public_metrics;
  if (!metrics) return null;

  return {
    raw: {
      impressions: metrics.impression_count ?? 0,
      likes: metrics.like_count ?? 0,
      retweets: metrics.retweet_count ?? 0,
      replies: metrics.reply_count ?? 0,
      bookmarks: metrics.bookmark_count ?? 0,
    },
    fetchedAt: new Date(),
  };
}
