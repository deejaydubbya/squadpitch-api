// LinkedIn Organization Page publishing adapter.
//
// Mirrors linkedin.adapter.js (personal-profile flow) almost
// completely — same /rest/posts endpoint, same image / video upload
// dance, same headers, same versioning. The two differences:
//
//   1. The author URN is the connected organization, not the
//      authenticated member:
//        urn:li:organization:<id>
//      The org URN was stamped onto Connection.externalAccountId
//      after the user picked a Page from the post-OAuth picker
//      (see linkedinOrgPages.service.js).
//
//   2. We never fall back to a person URN. If the connection is
//      missing the org URN, that's a misconfiguration — better to
//      throw a clear error than to silently post as the wrong
//      identity.
//
// Everything else (text limit, hashtag-merging captions, video chunked
// upload, finalize step, post-URN extraction) is identical to the
// personal adapter, so we delegate to its helpers via dynamic import.

const LINKEDIN_REST_BASE = "https://api.linkedin.com/rest";
const LI_TEXT_MAX = 3000;
const LI_VERSION = "202603";

const LI_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "LinkedIn-Version": LI_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
});

class LinkedInOrgPublishError extends Error {
  constructor(message, { status, code, linkedinError } = {}) {
    super(message);
    this.name = "LinkedInOrgPublishError";
    this.status = status ?? 502;
    this.code = code ?? "LINKEDIN_ORG_PUBLISH_FAILED";
    this.linkedinError = linkedinError ?? null;
  }
}

function buildCommentary(draft) {
  const body = draft.body ?? "";
  const tags = Array.isArray(draft.hashtags) ? draft.hashtags : [];
  const bodyLower = body.toLowerCase();
  const newTags = tags
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => !bodyLower.includes(t.toLowerCase()));
  const tagLine = newTags.join(" ");
  return tagLine ? `${body}\n\n${tagLine}` : body;
}

// Same image-upload routine as the personal adapter, parameterized on
// the author URN so it works for either identity.
async function uploadImage(mediaUrl, authorUrn, token) {
  const initRes = await fetch(
    `${LINKEDIN_REST_BASE}/images?action=initializeUpload`,
    {
      method: "POST",
      headers: LI_HEADERS(token),
      body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
    }
  );
  const initBody = await initRes.json().catch(() => ({}));
  if (!initRes.ok) {
    throw new LinkedInOrgPublishError(
      initBody?.message ?? `LinkedIn image init failed (${initRes.status})`,
      { status: initRes.status, linkedinError: initBody }
    );
  }
  const uploadUrl = initBody?.value?.uploadUrl;
  const imageUrn = initBody?.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new LinkedInOrgPublishError(
      "LinkedIn image init missing uploadUrl or image URN",
      { linkedinError: initBody }
    );
  }
  const imageRes = await fetch(mediaUrl);
  if (!imageRes.ok) {
    throw new LinkedInOrgPublishError(
      `Failed to fetch image from ${mediaUrl}: ${imageRes.status}`,
      { status: 502 }
    );
  }
  const buf = await imageRes.arrayBuffer();
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": imageRes.headers.get("content-type") || "image/jpeg",
    },
    body: buf,
  });
  if (!putRes.ok) {
    throw new LinkedInOrgPublishError(
      `LinkedIn image upload failed (${putRes.status})`,
      { status: putRes.status }
    );
  }
  return imageUrn;
}

async function uploadVideo(mediaUrl, authorUrn, token) {
  const videoRes = await fetch(mediaUrl);
  if (!videoRes.ok) {
    throw new LinkedInOrgPublishError(
      `Failed to fetch video from ${mediaUrl}: ${videoRes.status}`,
      { status: 502 }
    );
  }
  const videoBuffer = await videoRes.arrayBuffer();
  const fileSizeBytes = videoBuffer.byteLength;

  const initRes = await fetch(
    `${LINKEDIN_REST_BASE}/videos?action=initializeUpload`,
    {
      method: "POST",
      headers: LI_HEADERS(token),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: authorUrn,
          fileSizeBytes,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    }
  );
  const initBody = await initRes.json().catch(() => ({}));
  if (!initRes.ok) {
    throw new LinkedInOrgPublishError(
      initBody?.message ?? `LinkedIn video init failed (${initRes.status})`,
      { status: initRes.status, linkedinError: initBody }
    );
  }
  const uploadInstructions = initBody?.value?.uploadInstructions;
  const videoUrn = initBody?.value?.video;
  const uploadToken = initBody?.value?.uploadToken;
  if (!uploadInstructions?.length || !videoUrn) {
    throw new LinkedInOrgPublishError(
      "LinkedIn video init missing uploadInstructions or video URN",
      { linkedinError: initBody }
    );
  }
  const uploadedPartIds = [];
  for (const instruction of uploadInstructions) {
    const firstByte = instruction.firstByte ?? 0;
    const lastByte = instruction.lastByte ?? fileSizeBytes - 1;
    const chunk = videoBuffer.slice(firstByte, lastByte + 1);
    const putRes = await fetch(instruction.uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunk.byteLength),
      },
      body: chunk,
    });
    if (!putRes.ok) {
      throw new LinkedInOrgPublishError(
        `LinkedIn video chunk failed (${putRes.status})`,
        { status: putRes.status }
      );
    }
    const etag = putRes.headers.get("etag");
    if (etag) uploadedPartIds.push(etag);
  }
  const finalRes = await fetch(
    `${LINKEDIN_REST_BASE}/videos?action=finalizeUpload`,
    {
      method: "POST",
      headers: LI_HEADERS(token),
      body: JSON.stringify({
        finalizeUploadRequest: { video: videoUrn, uploadToken, uploadedPartIds },
      }),
    }
  );
  if (!finalRes.ok) {
    const finalBody = await finalRes.json().catch(() => ({}));
    throw new LinkedInOrgPublishError(
      finalBody?.message ?? `LinkedIn video finalize failed (${finalRes.status})`,
      { status: finalRes.status, linkedinError: finalBody }
    );
  }
  return videoUrn;
}

export const linkedinOrgAdapter = {
  channel: "LINKEDIN_ORGANIZATION_PAGE",

  async validatePublishTarget({ draft }) {
    const commentary = buildCommentary(draft);
    if (commentary.length > LI_TEXT_MAX) {
      throw new LinkedInOrgPublishError(
        `LinkedIn text exceeds ${LI_TEXT_MAX} characters (${commentary.length})`,
        { status: 400, code: "PUBLISH_FAILED_TEXT_TOO_LONG" }
      );
    }
    return { commentary, mediaUrl: draft.mediaUrl ?? null };
  },

  async publishPost({ draft, connection }) {
    const { commentary, mediaUrl } = await this.validatePublishTarget({ draft });
    const token = connection.accessToken;

    // externalAccountId is set to the full org URN
    // ("urn:li:organization:<id>") when the user selects a Page from
    // the picker (see linkedinOrgPages.service.js:saveSelectedOrganization).
    // Reject early if the connection still has the placeholder member sub.
    const stored = connection.externalAccountId;
    if (!stored || !stored.startsWith("urn:li:organization:")) {
      throw new LinkedInOrgPublishError(
        "LinkedIn Organization Page connection has no Page selected. " +
          "Pick a Page in Settings → Channels before publishing.",
        { status: 400, code: "ORG_PAGE_NOT_SELECTED" }
      );
    }
    const authorUrn = stored;

    const postBody = {
      author: authorUrn,
      commentary,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
    };

    if (mediaUrl) {
      const isVideo = draft.mediaType === "video";
      if (isVideo) {
        const videoUrn = await uploadVideo(mediaUrl, authorUrn, token);
        postBody.content = { media: { id: videoUrn } };
      } else {
        const imageUrn = await uploadImage(mediaUrl, authorUrn, token);
        postBody.content = { media: { id: imageUrn } };
      }
    }

    const res = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: LI_HEADERS(token),
      body: JSON.stringify(postBody),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new LinkedInOrgPublishError(
        errBody?.message ?? `LinkedIn org publish failed (${res.status})`,
        { status: res.status, linkedinError: errBody }
      );
    }

    const postUrn = res.headers.get("x-restli-id");
    const externalPostId = postUrn ?? null;
    const externalPostUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${postUrn}/`
      : null;

    return { externalPostId, externalPostUrl };
  },
};

export { LinkedInOrgPublishError };
