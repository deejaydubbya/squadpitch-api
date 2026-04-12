// TikTok metrics adapter.
//
// POST https://open.tiktokapis.com/v2/video/query/
// ?fields=like_count,comment_count,share_count,view_count

export async function fetchTiktokMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  const res = await fetch(
    "https://open.tiktokapis.com/v2/video/query/?fields=like_count,comment_count,share_count,view_count",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filters: { video_ids: [externalPostId] },
      }),
    }
  );

  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("TikTok auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`TikTok API ${res.status}`), { transient: true });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body?.error?.message ?? "TikTok query failed"), {
      transient: true,
    });
  }

  const video = body?.data?.videos?.[0];
  if (!video) return null;

  return {
    raw: {
      views: video.view_count ?? 0,
      likes: video.like_count ?? 0,
      comments: video.comment_count ?? 0,
      shares: video.share_count ?? 0,
    },
    fetchedAt: new Date(),
  };
}
