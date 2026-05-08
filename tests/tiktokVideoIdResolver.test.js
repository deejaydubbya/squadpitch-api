// resolveTiktokVideoId() tests.
//
// We exercise every branch of the resolver:
//   - already_resolved (numeric externalPostId, no fetch)
//   - newly_resolved (PUBLISH_COMPLETE; persists video_id + publishId)
//   - still_processing (PROCESSING_UPLOAD)
//   - publish_failed (FAILED with fail_reason)
//   - no_connection / token_refresh_failed / not_tiktok / no_publish_id
//   - http transient (5xx) and permanent (4xx)
//   - access token never appears in returned object

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock store + spies.
const drafts = new Map();
let lastUpdate = null;

const prismaMock = {
  draft: {
    findUnique: vi.fn(async ({ where }) => drafts.get(where.id) ?? null),
    update: vi.fn(async ({ where, data }) => {
      lastUpdate = { where, data };
      const existing = drafts.get(where.id);
      if (existing) drafts.set(where.id, { ...existing, ...data });
      return drafts.get(where.id);
    }),
  },
};

const connectionMock = vi.fn();
const tokenRefreshMock = vi.fn();

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../domains/studio/connection.service.js", () => ({
  getConnectionForAdapter: (...args) => connectionMock(...args),
}));
vi.mock("../domains/studio/tokenRefreshService.js", () => ({
  ensureValidAccessToken: (conn) => tokenRefreshMock(conn),
}));

const { resolveTiktokVideoId, looksLikeTiktokVideoId } = await import(
  "../domains/studio/publishing/tiktokVideoIdResolver.js"
);

beforeEach(() => {
  drafts.clear();
  lastUpdate = null;
  vi.clearAllMocks();
});

const SECRET = "supersecret-bearer-xyz123";
const PUBLISH_ID = "v_pub_url~v2-1.234567890";
const VIDEO_ID = "7234567890123456789";

function seedTikTokDraft(overrides = {}) {
  const draft = {
    id: "d1",
    clientId: "c1",
    channel: "TIKTOK",
    externalPostId: PUBLISH_ID,
    variations: null,
    ...overrides,
  };
  drafts.set(draft.id, draft);
  return draft;
}

describe("looksLikeTiktokVideoId", () => {
  it("accepts pure-digit strings", () => {
    expect(looksLikeTiktokVideoId(VIDEO_ID)).toBe(true);
    expect(looksLikeTiktokVideoId("123")).toBe(true);
  });
  it("rejects publish_id shapes and empty / non-string", () => {
    expect(looksLikeTiktokVideoId(PUBLISH_ID)).toBe(false);
    expect(looksLikeTiktokVideoId("")).toBe(false);
    expect(looksLikeTiktokVideoId(null)).toBe(false);
    expect(looksLikeTiktokVideoId(123)).toBe(false);
  });
});

describe("resolveTiktokVideoId — early exits", () => {
  it("draft_not_found", async () => {
    const r = await resolveTiktokVideoId({ draftId: "nope" });
    expect(r).toEqual({ resolved: false, status: "draft_not_found" });
  });

  it("not_tiktok when channel is something else", async () => {
    seedTikTokDraft({ channel: "INSTAGRAM" });
    const r = await resolveTiktokVideoId({ draftId: "d1" });
    expect(r).toEqual({ resolved: false, status: "not_tiktok" });
  });

  it("no_publish_id when externalPostId is null", async () => {
    seedTikTokDraft({ externalPostId: null });
    const r = await resolveTiktokVideoId({ draftId: "d1" });
    expect(r).toEqual({ resolved: false, status: "no_publish_id" });
  });

  it("already_resolved when externalPostId is a numeric video_id", async () => {
    seedTikTokDraft({ externalPostId: VIDEO_ID });
    const r = await resolveTiktokVideoId({ draftId: "d1" });
    expect(r).toEqual({ resolved: true, status: "already_resolved", videoId: VIDEO_ID });
    // Critical: no TikTok call, no DB write, no token use.
    expect(connectionMock).not.toHaveBeenCalled();
    expect(prismaMock.draft.update).not.toHaveBeenCalled();
  });
});

describe("resolveTiktokVideoId — connection + token failures", () => {
  it("no_connection when there's no live TikTok connection", async () => {
    seedTikTokDraft();
    connectionMock.mockResolvedValueOnce(null);
    const r = await resolveTiktokVideoId({ draftId: "d1" });
    expect(r).toEqual({ resolved: false, status: "no_connection" });
  });

  it("token_refresh_failed when refresh throws", async () => {
    seedTikTokDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: SECRET });
    tokenRefreshMock.mockRejectedValueOnce(new Error("revoked"));
    const r = await resolveTiktokVideoId({ draftId: "d1" });
    expect(r).toEqual({ resolved: false, status: "token_refresh_failed" });
    // Token must not leak into the result.
    expect(JSON.stringify(r)).not.toContain("supersecret");
  });
});

describe("resolveTiktokVideoId — TikTok status responses", () => {
  function withFetch(impl) {
    return resolveTiktokVideoId({ draftId: "d1", fetchImpl: impl });
  }

  function setupConnection() {
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: SECRET });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: SECRET });
  }

  it("PUBLISH_COMPLETE → newly_resolved + persists video_id + stashes publish_id in variations", async () => {
    seedTikTokDraft({ variations: { existingKey: "keep" } });
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          status: "PUBLISH_COMPLETE",
          publicaly_available_post_id: [VIDEO_ID],
        },
      }),
    });

    const r = await withFetch(fetchImpl);
    expect(r).toEqual({
      resolved: true,
      status: "newly_resolved",
      videoId: VIDEO_ID,
      publishId: PUBLISH_ID,
    });
    // Draft was updated with the new external id and existing variations preserved.
    expect(lastUpdate.data.externalPostId).toBe(VIDEO_ID);
    expect(lastUpdate.data.variations).toEqual({
      existingKey: "keep",
      tiktokPublishId: PUBLISH_ID,
    });
    // Token never appears in result.
    expect(JSON.stringify(r)).not.toContain("supersecret");
  });

  it("PUBLISH_COMPLETE accepts the spelling variant 'publicly_available_post_id' too", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          status: "PUBLISH_COMPLETE",
          publicly_available_post_id: [VIDEO_ID],
        },
      }),
    });
    const r = await withFetch(fetchImpl);
    expect(r.resolved).toBe(true);
    expect(r.videoId).toBe(VIDEO_ID);
  });

  it("PUBLISH_COMPLETE with no video_id in response → permanent failure (does NOT corrupt the draft)", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: "PUBLISH_COMPLETE" } }),
    });
    const r = await withFetch(fetchImpl);
    expect(r.resolved).toBe(false);
    expect(r.status).toBe("permanent");
    // Critical: draft.update was NOT called with a bogus value.
    expect(prismaMock.draft.update).not.toHaveBeenCalled();
  });

  it("PROCESSING_UPLOAD → still_processing (caller should re-poll)", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: "PROCESSING_UPLOAD" } }),
    });
    const r = await withFetch(fetchImpl);
    expect(r.resolved).toBe(false);
    expect(r.status).toBe("still_processing");
    expect(r.tiktokStatus).toBe("PROCESSING_UPLOAD");
    // Do not modify the draft while processing.
    expect(prismaMock.draft.update).not.toHaveBeenCalled();
  });

  it("SEND_TO_USER_INBOX → still_processing", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: "SEND_TO_USER_INBOX" } }),
    });
    const r = await withFetch(fetchImpl);
    expect(r.status).toBe("still_processing");
    expect(r.tiktokStatus).toBe("SEND_TO_USER_INBOX");
  });

  it("FAILED → publish_failed with fail_reason", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { status: "FAILED", fail_reason: "video_too_long" },
      }),
    });
    const r = await withFetch(fetchImpl);
    expect(r).toEqual({
      resolved: false,
      status: "publish_failed",
      failReason: "video_too_long",
    });
    expect(prismaMock.draft.update).not.toHaveBeenCalled();
  });

  it("HTTP 429 → transient (worker should retry)", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
    });
    const r = await withFetch(fetchImpl);
    expect(r.resolved).toBe(false);
    expect(r.status).toBe("transient");
    expect(r.httpStatus).toBe(429);
  });

  it("HTTP 503 → transient", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const r = await withFetch(fetchImpl);
    expect(r.status).toBe("transient");
  });

  it("HTTP 401 → permanent (no retry)", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const r = await withFetch(fetchImpl);
    expect(r.status).toBe("permanent");
    expect(r.httpStatus).toBe(401);
  });

  it("network error → transient (no httpStatus)", async () => {
    seedTikTokDraft();
    setupConnection();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const r = await withFetch(fetchImpl);
    expect(r.status).toBe("transient");
  });
});

describe("resolveTiktokVideoId — request payload sanity", () => {
  it("POSTs to the status endpoint with publish_id in the body and bearer token in the header", async () => {
    seedTikTokDraft();
    connectionMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: SECRET });
    tokenRefreshMock.mockResolvedValueOnce({ status: "CONNECTED", accessToken: SECRET });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: "PROCESSING_UPLOAD" } }),
    });
    await resolveTiktokVideoId({ draftId: "d1", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/status/fetch/");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body)).toEqual({ publish_id: PUBLISH_ID });
  });
});
