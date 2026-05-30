// Threads publishing adapter tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../domains/studio/threads.constants.js", () => ({
  THREADS_GRAPH_BASE: "https://graph.test/v1.0",
  THREADS_GRAPH_HOST: "https://graph.test",
}));

// spinstr418 — publishing is gated by env.THREADS_PUBLISHING_ENABLED
// at the adapter entry. Tests assume the gate is open so the
// existing two-step container/publish behavior is exercised.
let envOverrides;
vi.mock("../config/env.js", () => ({
  get env() {
    return envOverrides;
  },
}));

const { threadsAdapter } = await import(
  "../domains/studio/publishing/channelAdapters/threads.adapter.js"
);

const TOKEN = "supersecret-threads-token-xyz";
const USER_ID = "9999";

let fetchMock;
const origFetch = global.fetch;
beforeEach(() => {
  envOverrides = { THREADS_PUBLISHING_ENABLED: true };
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = origFetch;
});

const ok = (body) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });
const err = (status, body) =>
  Promise.resolve({ ok: false, status, json: async () => body });

const conn = () => ({ externalAccountId: USER_ID, accessToken: TOKEN });

describe("threadsAdapter.validatePublishTarget", () => {
  it("rejects text-only posts longer than 500 chars", async () => {
    const draft = { body: "x".repeat(501), hashtags: [], mediaType: null };
    await expect(
      threadsAdapter.validatePublishTarget({ draft, client: {} })
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED_TEXT_TOO_LONG" });
  });

  it("rejects image posts without a media URL", async () => {
    const draft = { body: "hi", hashtags: [], mediaType: "image" };
    await expect(
      threadsAdapter.validatePublishTarget({ draft, client: {} })
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED_NO_MEDIA" });
  });

  it("accepts a text-only post under the limit", async () => {
    const draft = { body: "Hello threads", hashtags: ["#hi"], mediaType: null };
    const r = await threadsAdapter.validatePublishTarget({ draft, client: {} });
    expect(r.text).toContain("Hello threads");
    expect(r.text).toContain("#hi");
    expect(r.mediaContainerType).toBe("TEXT");
  });
});

describe("threadsAdapter.publishPost — text-only", () => {
  it("creates container then publishes; returns externalPostId + permalink", async () => {
    fetchMock
      // 1. POST /me/threads (create container)
      .mockReturnValueOnce(ok({ id: "container_1" }))
      // 2. POST /me/threads_publish (publish)
      .mockReturnValueOnce(ok({ id: "thread_42" }))
      // 3. GET /thread_42?fields=permalink
      .mockReturnValueOnce(
        ok({ permalink: "https://www.threads.net/@u/post/abc" })
      );

    const r = await threadsAdapter.publishPost({
      draft: { body: "Hi there", hashtags: [], mediaType: null },
      connection: conn(),
      client: {},
    });
    expect(r.externalPostId).toBe("thread_42");
    expect(r.externalPostUrl).toBe("https://www.threads.net/@u/post/abc");
    // Text posts must NOT poll the container.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("classifies provider 4xx as a publish failure", async () => {
    fetchMock.mockReturnValueOnce(
      err(400, { error: { code: 100, message: "bad" } })
    );
    await expect(
      threadsAdapter.publishPost({
        draft: { body: "Hi", hashtags: [], mediaType: null },
        connection: conn(),
        client: {},
      })
    ).rejects.toMatchObject({ code: "THREADS_PUBLISH_FAILED" });
  });

  // spinstr418 — kill switch must halt publishPost before any
  // fetch happens. The env flag is separate from THREADS_ENABLED
  // (which gates OAuth + Inbox) so a workspace can keep the
  // Inbox integration on while we decide whether organic
  // publishing should fire from a deploy.
  it("refuses publishPost when THREADS_PUBLISHING_ENABLED is false (no fetch fired)", async () => {
    envOverrides = { THREADS_PUBLISHING_ENABLED: false };
    await expect(
      threadsAdapter.publishPost({
        draft: { body: "Hi", hashtags: [], mediaType: null },
        connection: conn(),
        client: {},
      })
    ).rejects.toMatchObject({ code: "THREADS_PUBLISHING_DISABLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("threadsAdapter.publishPost — image with polling", () => {
  it("creates container, polls until FINISHED, then publishes", async () => {
    fetchMock
      // 1. POST /me/threads (image container)
      .mockReturnValueOnce(ok({ id: "container_2" }))
      // 2. poll: status IN_PROGRESS
      .mockReturnValueOnce(ok({ status: "IN_PROGRESS" }))
      // 3. poll: status FINISHED
      .mockReturnValueOnce(ok({ status: "FINISHED" }))
      // 4. publish
      .mockReturnValueOnce(ok({ id: "thread_99" }))
      // 5. permalink
      .mockReturnValueOnce(ok({ permalink: "https://www.threads.net/x" }));

    const r = await threadsAdapter.publishPost({
      draft: {
        body: "Photo!",
        hashtags: [],
        mediaType: "image",
        mediaUrl: "https://cdn.example/img.jpg",
      },
      connection: conn(),
      client: {},
    });
    expect(r.externalPostId).toBe("thread_99");
  });

  it("surfaces ERROR status from container polling", async () => {
    fetchMock
      .mockReturnValueOnce(ok({ id: "container_3" }))
      .mockReturnValueOnce(
        ok({ status: "ERROR", error_message: "Media URL unreachable" })
      );

    await expect(
      threadsAdapter.publishPost({
        draft: {
          body: "x",
          hashtags: [],
          mediaType: "image",
          mediaUrl: "https://cdn.example/img.jpg",
        },
        connection: conn(),
        client: {},
      })
    ).rejects.toMatchObject({ code: "THREADS_PUBLISH_FAILED" });
  });
});
