// YouTube metrics adapter.
//
// GET https://www.googleapis.com/youtube/v3/videos?part=statistics&id={id}

export async function fetchYoutubeMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  const url =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=statistics&id=${encodeURIComponent(externalPostId)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("YouTube auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`YouTube API ${res.status}`), { transient: true });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(body?.error?.message ?? "YouTube statistics failed"),
      { transient: true }
    );
  }

  const item = body?.items?.[0];
  if (!item) return null;

  const stats = item.statistics ?? {};
  return {
    raw: {
      views: Number(stats.viewCount) || 0,
      likes: Number(stats.likeCount) || 0,
      comments: Number(stats.commentCount) || 0,
      favorites: Number(stats.favoriteCount) || 0,
    },
    fetchedAt: new Date(),
  };
}
