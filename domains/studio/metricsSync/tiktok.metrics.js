// TikTok metrics adapter.
//
// POST https://open.tiktokapis.com/v2/video/query/
// ?fields=like_count,comment_count,share_count,view_count
//
// IMPORTANT — publish_id vs video_id:
//   The publishing flow calls /v2/post/publish/content/init/ which
//   returns a `publish_id` (the upload-session handle, looks like
//   "v_pub_url~v2-1.<digits>"). The current TikTok publish adapter
//   stores that publish_id as Draft.externalPostId.
//   The metrics endpoint /v2/video/query/ requires the FINAL
//   `video_id` (a pure numeric string). Calling it with a publish_id
//   simply returns an empty result — silent failure.
//   Until the publish flow is upgraded to poll
//   /v2/post/publish/status/fetch/ for the resolved video_id and
//   overwrite externalPostId, this adapter detects publish-id-shaped
//   inputs up front and surfaces a typed TIKTOK_VIDEO_ID_MISSING
//   error so the metricsSyncService can label the row clearly.
//   See docs/SOCIAL_METRICS_FEEDBACK_LOOP.md § TikTok for the full
//   fix path.
//
// Heuristic: TikTok video_ids are pure digits (e.g. "7234567890123456789").
// publish_ids carry a tilde + version segment ("v_pub_url~v2-…").

const PUBLISH_ID_HINT = /[~]|^v_pub_/;

function looksLikePublishId(externalPostId) {
  if (!externalPostId || typeof externalPostId !== "string") return false;
  return PUBLISH_ID_HINT.test(externalPostId);
}

export async function fetchTiktokMetrics({ connection, externalPostId }) {
  if (looksLikePublishId(externalPostId)) {
    throw Object.assign(
      new Error(
        "TikTok metrics require the published video_id, but Draft.externalPostId stores the upload-session publish_id. " +
        "Resolve the video_id by polling /v2/post/publish/status/fetch/ after publish (TODO)."
      ),
      { code: "TIKTOK_VIDEO_ID_MISSING", channel: "TIKTOK" }
    );
  }

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
