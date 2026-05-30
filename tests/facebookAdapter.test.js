// Facebook publish adapter — externalPostId selection.
//
// spinstr410 bug: image posts were storing the PHOTO MEDIA id
// (`postResult.id`) instead of the FEED POST id
// (`postResult.post_id`). When fetched via ?fields=permalink_url
// the photo id returns a /photo.php?fbid=... lightbox URL that
// Facebook gates behind a login interstitial for logged-out
// viewers, even when the post itself is fully public. The
// canonical /<page>/posts/<id> URL (derived from post_id) loads
// cleanly in incognito.
//
// These tests pin the fix:
//   - /photos response with both id + post_id → externalPostId
//     becomes post_id, permalink GET uses post_id.
//   - /feed response (text-only) only returns id → still works.
//   - /videos response (video) only returns id → still works.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { facebookAdapter } from "../domains/studio/publishing/channelAdapters/facebook.adapter.js";

const PAGE_ID = "1234567890";
const PHOTO_ID = "photo_999";
const FEED_POST_ID = `${PAGE_ID}_888`;
const VIDEO_ID = "vid_777";
const FEED_TEXT_POST_ID = `${PAGE_ID}_777`;
const TOKEN = "sentinel-token";

function makeDraft(overrides = {}) {
  return {
    id: "draft-1",
    body: "Just listed in Cary",
    hashtags: ["realestate"],
    mediaType: "image",
    mediaUrl: "https://res.cloudinary.com/test/image.jpg",
    ...overrides,
  };
}
const CONNECTION = { externalAccountId: PAGE_ID, accessToken: TOKEN };

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper — match an outbound URL by substring AND optionally by
// inspecting the URL itself (for the permalink fetch which is GET).
function mockFetchSequence(handlers) {
  let i = 0;
  fetchMock.mockImplementation(async (url, opts) => {
    const handler = handlers[i++];
    if (!handler) throw new Error(`Unexpected fetch #${i} to ${url}`);
    return handler(url, opts);
  });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// ── Photo post — the spinstr410 bug ────────────────────────────────────

describe("facebookAdapter.publishPost — image post (POST /photos)", () => {
  it("prefers post_id over id when both are present (spinstr410 fix)", async () => {
    mockFetchSequence([
      // /photos POST returns both ids
      (url, opts) => {
        expect(url).toBe(`https://graph.facebook.com/v19.0/${PAGE_ID}/photos`);
        expect(opts.method).toBe("POST");
        const params = new URLSearchParams(opts.body);
        expect(params.get("url")).toBe("https://res.cloudinary.com/test/image.jpg");
        expect(params.get("access_token")).toBe(TOKEN);
        return jsonResponse({ id: PHOTO_ID, post_id: FEED_POST_ID });
      },
      // permalink GET — MUST use post_id, NOT photo id
      (url) => {
        expect(url).toContain(`/${FEED_POST_ID}?fields=permalink_url`);
        expect(url).not.toContain(`/${PHOTO_ID}?fields=`);
        return jsonResponse({
          permalink_url: `https://www.facebook.com/100/posts/888`,
        });
      },
    ]);

    const result = await facebookAdapter.publishPost({
      draft: makeDraft(),
      connection: CONNECTION,
    });
    expect(result.externalPostId).toBe(FEED_POST_ID);
    expect(result.externalPostUrl).toBe("https://www.facebook.com/100/posts/888");
  });

  it("falls back to id when post_id is missing (legacy/unexpected shape)", async () => {
    mockFetchSequence([
      () => jsonResponse({ id: PHOTO_ID }), // no post_id
      (url) => {
        expect(url).toContain(`/${PHOTO_ID}?fields=permalink_url`);
        return jsonResponse({ permalink_url: "https://facebook.com/photo.php?fbid=999" });
      },
    ]);

    const result = await facebookAdapter.publishPost({
      draft: makeDraft(),
      connection: CONNECTION,
    });
    expect(result.externalPostId).toBe(PHOTO_ID);
  });

  it("throws PROVIDER_NO_EXTERNAL_ID-shaped error when neither id nor post_id is returned", async () => {
    mockFetchSequence([() => jsonResponse({}, 200)]);
    await expect(
      facebookAdapter.publishPost({ draft: makeDraft(), connection: CONNECTION }),
    ).rejects.toMatchObject({
      name: "FacebookPublishError",
      code: "FACEBOOK_PUBLISH_FAILED",
    });
  });
});

// ── Text-only post — /feed returns id (already the feed post id) ──────

describe("facebookAdapter.publishPost — text-only post (POST /feed)", () => {
  it("uses the id from /feed as externalPostId (no post_id field present)", async () => {
    mockFetchSequence([
      (url, opts) => {
        expect(url).toBe(`https://graph.facebook.com/v19.0/${PAGE_ID}/feed`);
        const params = new URLSearchParams(opts.body);
        expect(params.get("message")).toContain("Just listed");
        // /feed never has post_id in the response — only id.
        return jsonResponse({ id: FEED_TEXT_POST_ID });
      },
      (url) => {
        // Permalink fetch uses the id (which IS the feed post id here).
        expect(url).toContain(`/${FEED_TEXT_POST_ID}?fields=permalink_url`);
        return jsonResponse({
          permalink_url: `https://www.facebook.com/100/posts/777`,
        });
      },
    ]);

    const result = await facebookAdapter.publishPost({
      draft: makeDraft({ mediaUrl: null, mediaType: null }),
      connection: CONNECTION,
    });
    expect(result.externalPostId).toBe(FEED_TEXT_POST_ID);
    expect(result.externalPostUrl).toBe("https://www.facebook.com/100/posts/777");
  });
});

// ── Video post — /videos returns video_id only ─────────────────────────

describe("facebookAdapter.publishPost — video post (POST /videos)", () => {
  it("uses the id from /videos as externalPostId", async () => {
    mockFetchSequence([
      (url, opts) => {
        expect(url).toBe(`https://graph.facebook.com/v19.0/${PAGE_ID}/videos`);
        const params = new URLSearchParams(opts.body);
        expect(params.get("file_url")).toBeTruthy();
        expect(params.get("description")).toContain("Just listed");
        return jsonResponse({ id: VIDEO_ID });
      },
      (url) => {
        expect(url).toContain(`/${VIDEO_ID}?fields=permalink_url`);
        // Videos sometimes don't have a permalink_url yet (still
        // processing) — non-fatal.
        return jsonResponse({});
      },
    ]);

    const result = await facebookAdapter.publishPost({
      draft: makeDraft({ mediaType: "video", mediaUrl: "https://res.cloudinary.com/test/v.mp4" }),
      connection: CONNECTION,
    });
    expect(result.externalPostId).toBe(VIDEO_ID);
    expect(result.externalPostUrl).toBeNull(); // permalink not ready yet — non-fatal
  });
});

// ── Connection guards ──────────────────────────────────────────────────

describe("facebookAdapter.publishPost — connection guards", () => {
  it("throws when connection has no Page ID", async () => {
    await expect(
      facebookAdapter.publishPost({
        draft: makeDraft(),
        connection: { externalAccountId: null, accessToken: TOKEN },
      }),
    ).rejects.toMatchObject({ code: "FACEBOOK_CONNECTION_INVALID" });
  });

  it("surfaces Meta's error message on a non-2xx response", async () => {
    mockFetchSequence([
      () =>
        jsonResponse(
          { error: { message: "Page is restricted", code: 200 } },
          400,
        ),
    ]);
    await expect(
      facebookAdapter.publishPost({ draft: makeDraft(), connection: CONNECTION }),
    ).rejects.toMatchObject({
      message: "Page is restricted",
      code: "FACEBOOK_PUBLISH_FAILED",
    });
  });
});
