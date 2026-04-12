// LinkedIn metrics adapter.
//
// GET https://api.linkedin.com/rest/organizationalEntityShareStatistics
//   ?q=shares&shares=urn:li:share:{id}

export async function fetchLinkedinMetrics({ connection, externalPostId }) {
  const token = connection.accessToken;

  const shareUrn = externalPostId.startsWith("urn:")
    ? externalPostId
    : `urn:li:share:${externalPostId}`;

  const url =
    `https://api.linkedin.com/rest/organizationalEntityShareStatistics` +
    `?q=shares&shares=${encodeURIComponent(shareUrn)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": "202401",
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });

  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("LinkedIn auth failed"), { code: "AUTH_FAILED" });
  }
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`LinkedIn API ${res.status}`), { transient: true });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body?.message ?? "LinkedIn stats failed"), { transient: true });
  }

  const element = body?.elements?.[0];
  if (!element) return null;

  const stats = element.totalShareStatistics ?? {};
  return {
    raw: {
      impressions: stats.impressionCount ?? 0,
      clicks: stats.clickCount ?? 0,
      likes: stats.likeCount ?? 0,
      comments: stats.commentCount ?? 0,
      shares: stats.shareCount ?? 0,
    },
    fetchedAt: new Date(),
  };
}
