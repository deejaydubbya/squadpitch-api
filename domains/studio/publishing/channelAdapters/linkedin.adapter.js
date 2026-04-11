// LinkedIn publishing adapter.
//
// Text post: POST https://api.linkedin.com/rest/posts
// Image post: 3-step flow:
//   1. POST /rest/images?action=initializeUpload  -> get uploadUrl + image URN
//   2. PUT uploadUrl with binary image data
//   3. POST /rest/posts with image URN in content
// Text limit: 3,000 characters

const LINKEDIN_REST_BASE = "https://api.linkedin.com/rest";
const LI_TEXT_MAX = 3000;
const LI_VERSION = "202603";

const LI_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "LinkedIn-Version": LI_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
});

class LinkedInPublishError extends Error {
  constructor(message, { status, code, linkedinError } = {}) {
    super(message);
    this.name = "LinkedInPublishError";
    this.status = status ?? 502;
    this.code = code ?? "LINKEDIN_PUBLISH_FAILED";
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

/**
 * Upload an image to LinkedIn and return the image URN.
 * 3-step: initialize upload -> fetch image -> PUT binary to LinkedIn.
 */
async function uploadImage(mediaUrl, authorUrn, token) {
  // 1. Initialize upload
  const initRes = await fetch(
    `${LINKEDIN_REST_BASE}/images?action=initializeUpload`,
    {
      method: "POST",
      headers: LI_HEADERS(token),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: authorUrn,
        },
      }),
    }
  );
  const initBody = await initRes.json().catch(() => ({}));
  if (!initRes.ok) {
    throw new LinkedInPublishError(
      initBody?.message ?? `LinkedIn image init failed with ${initRes.status}`,
      { status: initRes.status, linkedinError: initBody }
    );
  }

  const uploadUrl = initBody?.value?.uploadUrl;
  const imageUrn = initBody?.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new LinkedInPublishError(
      "LinkedIn image init response missing uploadUrl or image URN",
      { linkedinError: initBody }
    );
  }

  // 2. Fetch the image binary from our media URL
  const imageRes = await fetch(mediaUrl);
  if (!imageRes.ok) {
    throw new LinkedInPublishError(
      `Failed to fetch image from ${mediaUrl}: ${imageRes.status}`,
      { status: 502 }
    );
  }
  const imageBuffer = await imageRes.arrayBuffer();

  // 3. PUT binary to LinkedIn's upload URL
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": imageRes.headers.get("content-type") || "image/jpeg",
    },
    body: imageBuffer,
  });
  if (!putRes.ok) {
    throw new LinkedInPublishError(
      `LinkedIn image upload failed with ${putRes.status}`,
      { status: putRes.status }
    );
  }

  return imageUrn;
}

/**
 * Upload a video to LinkedIn and return the video URN.
 * 3-step: initialize upload -> fetch video -> PUT binary to LinkedIn -> finalize.
 */
async function uploadVideo(mediaUrl, authorUrn, token) {
  // 1. Fetch the video binary first to get file size
  const videoRes = await fetch(mediaUrl);
  if (!videoRes.ok) {
    throw new LinkedInPublishError(
      `Failed to fetch video from ${mediaUrl}: ${videoRes.status}`,
      { status: 502 }
    );
  }
  const videoBuffer = await videoRes.arrayBuffer();
  const fileSizeBytes = videoBuffer.byteLength;

  // 2. Initialize upload
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
    throw new LinkedInPublishError(
      initBody?.message ?? `LinkedIn video init failed with ${initRes.status}`,
      { status: initRes.status, linkedinError: initBody }
    );
  }

  const uploadInstructions = initBody?.value?.uploadInstructions;
  const videoUrn = initBody?.value?.video;
  const uploadToken = initBody?.value?.uploadToken;

  if (!uploadInstructions?.length || !videoUrn) {
    throw new LinkedInPublishError(
      "LinkedIn video init response missing uploadInstructions or video URN",
      { linkedinError: initBody }
    );
  }

  // 3. PUT each chunk to upload URLs (each instruction specifies a byte range)
  const uploadedPartIds = [];
  for (const instruction of uploadInstructions) {
    const firstByte = instruction.firstByte ?? 0;
    const lastByte = instruction.lastByte ?? (fileSizeBytes - 1);
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
      const errText = await putRes.text().catch(() => "");
      throw new LinkedInPublishError(
        `LinkedIn video upload chunk failed with ${putRes.status}: ${errText}`,
        { status: putRes.status }
      );
    }
    // Collect ETag for finalize step
    const etag = putRes.headers.get("etag");
    if (etag) uploadedPartIds.push(etag);
  }

  // 4. Finalize upload
  const finalRes = await fetch(
    `${LINKEDIN_REST_BASE}/videos?action=finalizeUpload`,
    {
      method: "POST",
      headers: LI_HEADERS(token),
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken,
          uploadedPartIds,
        },
      }),
    }
  );
  if (!finalRes.ok) {
    const finalBody = await finalRes.json().catch(() => ({}));
    throw new LinkedInPublishError(
      finalBody?.message ?? `LinkedIn video finalize failed with ${finalRes.status}`,
      { status: finalRes.status, linkedinError: finalBody }
    );
  }

  return videoUrn;
}

export const linkedinAdapter = {
  channel: "LINKEDIN",

  async validatePublishTarget({ draft }) {
    const commentary = buildCommentary(draft);
    if (commentary.length > LI_TEXT_MAX) {
      throw new LinkedInPublishError(
        `LinkedIn text exceeds ${LI_TEXT_MAX} characters (${commentary.length})`,
        { status: 400, code: "PUBLISH_FAILED_TEXT_TOO_LONG" }
      );
    }
    return { commentary, mediaUrl: draft.mediaUrl ?? null };
  },

  async publishPost({ draft, connection, client }) {
    const { commentary, mediaUrl } = await this.validatePublishTarget({ draft });
    const token = connection.accessToken;
    const personUrn = connection.externalAccountId;

    if (!personUrn) {
      throw new LinkedInPublishError(
        "Connection is missing a LinkedIn person URN (sub)",
        { status: 500, code: "LINKEDIN_CONNECTION_INVALID" }
      );
    }

    const authorUrn = `urn:li:person:${personUrn}`;

    // Build post body — with or without image
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
        postBody.content = {
          media: {
            id: videoUrn,
          },
        };
      } else {
        const imageUrn = await uploadImage(mediaUrl, authorUrn, token);
        postBody.content = {
          media: {
            id: imageUrn,
          },
        };
      }
    }

    const res = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: "POST",
      headers: LI_HEADERS(token),
      body: JSON.stringify(postBody),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new LinkedInPublishError(
        errBody?.message ?? `LinkedIn publish failed with ${res.status}`,
        { status: res.status, linkedinError: errBody }
      );
    }

    // LinkedIn returns the post URN in the x-restli-id header
    const postUrn = res.headers.get("x-restli-id");
    const externalPostId = postUrn ?? null;

    let externalPostUrl = null;
    if (postUrn) {
      externalPostUrl = `https://www.linkedin.com/feed/update/${postUrn}/`;
    }

    return { externalPostId, externalPostUrl };
  },
};

export { LinkedInPublishError };
