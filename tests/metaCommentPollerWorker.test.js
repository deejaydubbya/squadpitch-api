// Boot behavior of the Facebook + Instagram comment poller workers.
//
// Covers the gate matrix:
//   - META_COMMENT_POLLING_ENABLED=false → start() returns a noop
//     close handle, never instantiates a BullMQ Queue/Worker.
//   - META_COMMENT_POLLING_ENABLED=true + no Redis → start() returns
//     a noop close handle and logs a clear disabled warning.
//
// Also pins a sanity check that the deprecated webhook env vars
// (META_WEBHOOK_VERIFY_TOKEN + META_INBOX_INGESTION_ENABLED) are NOT
// re-introduced on the env config — Prompt 01 removed them and they
// must stay gone.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture every Queue/Worker construction so we can assert "no
// instances created" when the worker is disabled.
const queueInstances = [];
const workerInstances = [];

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    constructor(name, opts) {
      queueInstances.push({ name, opts });
      this.name = name;
    }
    add() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  },
  Worker: class FakeWorker {
    constructor(name, handler, opts) {
      workerInstances.push({ name, handler, opts });
    }
    on() {}
    close() {
      return Promise.resolve();
    }
  },
}));

// Redis presence is the second gate — fully controlled per test.
let redisAvailable = true;
vi.mock("../redis.js", () => ({
  getRedisConnection: () => (redisAvailable ? { __fake: true } : null),
  getRedis: () => null,
}));

// Env override hook so each test flips META_COMMENT_POLLING_ENABLED.
let envOverrides = {};
vi.mock("../config/env.js", () => ({
  get env() {
    return {
      META_COMMENT_POLLING_ENABLED: false,
      META_COMMENT_POLLING_INTERVAL_MINUTES: 15,
      META_COMMENT_POLLING_LOOKBACK_DAYS: 30,
      ...envOverrides,
    };
  },
}));

let warnSpy;
let logSpy;
beforeEach(() => {
  envOverrides = {};
  redisAvailable = true;
  queueInstances.length = 0;
  workerInstances.length = 0;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("facebookCommentPollerWorker — gating", () => {
  it("returns a noop and skips queue/worker construction when META_COMMENT_POLLING_ENABLED=false", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: false };
    const mod = await import("../workers/facebookCommentPollerWorker.js");
    const handle = mod.startFacebookCommentPollerWorker();
    expect(typeof handle.close).toBe("function");
    await handle.close();
    expect(queueInstances).toHaveLength(0);
    expect(workerInstances).toHaveLength(0);
    expect(
      warnSpy.mock.calls.some((args) =>
        String(args[0] ?? "").includes("META_COMMENT_POLLING_ENABLED=false"),
      ),
    ).toBe(true);
  });

  it("returns a noop when ENABLED=true but Redis is unavailable", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: true };
    redisAvailable = false;
    const mod = await import("../workers/facebookCommentPollerWorker.js");
    const handle = mod.startFacebookCommentPollerWorker();
    expect(typeof handle.close).toBe("function");
    await handle.close();
    expect(queueInstances).toHaveLength(0);
    expect(workerInstances).toHaveLength(0);
    expect(
      warnSpy.mock.calls.some((args) =>
        String(args[0] ?? "").includes("No Redis"),
      ),
    ).toBe(true);
  });

  it("boots the queue + worker when ENABLED=true and Redis is available", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: true };
    redisAvailable = true;
    const mod = await import("../workers/facebookCommentPollerWorker.js");
    const handle = mod.startFacebookCommentPollerWorker();
    await handle.close();
    expect(queueInstances).toHaveLength(1);
    expect(queueInstances[0].name).toBe("sp-facebook-comments-poll");
    expect(workerInstances).toHaveLength(1);
  });

  it("enqueueFacebookCommentPollForConnection throws QUEUE_UNAVAILABLE when Redis is down", async () => {
    redisAvailable = false;
    const mod = await import("../workers/facebookCommentPollerWorker.js");
    let caught;
    try {
      await mod.enqueueFacebookCommentPollForConnection("conn-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("QUEUE_UNAVAILABLE");
    expect(caught.status).toBe(503);
  });
});

describe("instagramCommentPollerWorker — gating", () => {
  it("returns a noop and skips queue/worker construction when META_COMMENT_POLLING_ENABLED=false", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: false };
    const mod = await import("../workers/instagramCommentPollerWorker.js");
    const handle = mod.startInstagramCommentPollerWorker();
    expect(typeof handle.close).toBe("function");
    await handle.close();
    expect(queueInstances).toHaveLength(0);
    expect(workerInstances).toHaveLength(0);
    expect(
      warnSpy.mock.calls.some((args) =>
        String(args[0] ?? "").includes("META_COMMENT_POLLING_ENABLED=false"),
      ),
    ).toBe(true);
  });

  it("returns a noop when ENABLED=true but Redis is unavailable", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: true };
    redisAvailable = false;
    const mod = await import("../workers/instagramCommentPollerWorker.js");
    const handle = mod.startInstagramCommentPollerWorker();
    expect(typeof handle.close).toBe("function");
    await handle.close();
    expect(queueInstances).toHaveLength(0);
    expect(workerInstances).toHaveLength(0);
  });

  it("boots the queue + worker when ENABLED=true and Redis is available", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: true };
    redisAvailable = true;
    const mod = await import("../workers/instagramCommentPollerWorker.js");
    const handle = mod.startInstagramCommentPollerWorker();
    await handle.close();
    expect(queueInstances).toHaveLength(1);
    expect(queueInstances[0].name).toBe("sp-instagram-comments-poll");
    expect(workerInstances).toHaveLength(1);
  });

  it("enqueueInstagramCommentPollForConnection throws QUEUE_UNAVAILABLE when Redis is down", async () => {
    redisAvailable = false;
    const mod = await import("../workers/instagramCommentPollerWorker.js");
    let caught;
    try {
      await mod.enqueueInstagramCommentPollForConnection("conn-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("QUEUE_UNAVAILABLE");
    expect(caught.status).toBe(503);
  });
});

describe("env.js — webhook removal sanity", () => {
  it("does NOT export META_WEBHOOK_VERIFY_TOKEN or META_INBOX_INGESTION_ENABLED", async () => {
    // Read the real module from disk, not the mocked one above. We
    // intentionally vi.resetModules() in beforeEach so this picks up
    // a fresh evaluation against the actual file contents.
    vi.doUnmock("../config/env.js");
    vi.resetModules();
    const { env: realEnv } = await import("../config/env.js");
    expect(realEnv).not.toHaveProperty("META_WEBHOOK_VERIFY_TOKEN");
    expect(realEnv).not.toHaveProperty("META_INBOX_INGESTION_ENABLED");
    // The new flags should be present with sensible defaults.
    expect(realEnv).toHaveProperty("META_COMMENT_POLLING_ENABLED");
    expect(realEnv.META_COMMENT_POLLING_ENABLED).toBe(false);
    expect(realEnv.META_COMMENT_POLLING_INTERVAL_MINUTES).toBe(15);
    expect(realEnv.META_COMMENT_POLLING_LOOKBACK_DAYS).toBe(30);
  });
});
