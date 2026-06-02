// Boot behavior of the Facebook + Instagram comment poller workers.
//
// Covers the gate matrix:
//   - No Redis → start() returns a noop close handle, never
//     instantiates a Queue/Worker.
//   - META_COMMENT_POLLING_ENABLED=false + Redis → Worker DOES start
//     (so manual /sync-comments jobs get processed) but the recurring
//     scheduled tick is NOT added. The original 2026-06-02 bug was
//     that the Worker skipped entirely, leaving manual-enqueued jobs
//     to sit in Redis with no consumer.
//   - META_COMMENT_POLLING_ENABLED=true + Redis → Worker starts AND
//     the recurring tick is added.
//
// Also pins a sanity check that the deprecated webhook env vars
// (META_WEBHOOK_VERIFY_TOKEN + META_INBOX_INGESTION_ENABLED) are NOT
// re-introduced on the env config — Prompt 01 removed them and they
// must stay gone.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture every Queue/Worker construction + queue.add() call so we
// can assert which jobs were scheduled.
const queueInstances = [];
const workerInstances = [];
const queueAddCalls = [];

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    constructor(name, opts) {
      queueInstances.push({ name, opts });
      this.name = name;
    }
    add(jobName, data, opts) {
      queueAddCalls.push({ queue: this.name, jobName, data, opts });
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
  queueAddCalls.length = 0;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("facebookCommentPollerWorker — gating", () => {
  it("returns a noop when Redis is unavailable (flag irrelevant)", async () => {
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

  it("ENABLED=false + Redis → Worker DOES start (for manual jobs) but recurring tick is NOT scheduled", async () => {
    // Regression guard for the 2026-06-02 bug: prior to the fix the
    // Worker was skipped when the flag was false, so manual-enqueued
    // jobs sat in Redis with no consumer and the /sync-comments route
    // returned a misleading 202.
    envOverrides = { META_COMMENT_POLLING_ENABLED: false };
    const mod = await import("../workers/facebookCommentPollerWorker.js");
    const handle = mod.startFacebookCommentPollerWorker();
    await handle.close();
    expect(queueInstances).toHaveLength(1);
    expect(workerInstances).toHaveLength(1);
    // No recurring job added because the scheduler is gated.
    expect(
      queueAddCalls.find((c) => c.jobName === "poll-facebook-comments"),
    ).toBeUndefined();
  });

  it("ENABLED=true + Redis → Worker starts AND the recurring tick is scheduled", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: true };
    const mod = await import("../workers/facebookCommentPollerWorker.js");
    const handle = mod.startFacebookCommentPollerWorker();
    await handle.close();
    expect(queueInstances).toHaveLength(1);
    expect(queueInstances[0].name).toBe("sp-facebook-comments-poll");
    expect(workerInstances).toHaveLength(1);
    const recurring = queueAddCalls.find(
      (c) => c.jobName === "poll-facebook-comments",
    );
    expect(recurring).toBeDefined();
    expect(recurring.opts?.repeat?.every).toBe(15 * 60_000);
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
  it("returns a noop when Redis is unavailable (flag irrelevant)", async () => {
    redisAvailable = false;
    const mod = await import("../workers/instagramCommentPollerWorker.js");
    const handle = mod.startInstagramCommentPollerWorker();
    expect(typeof handle.close).toBe("function");
    await handle.close();
    expect(queueInstances).toHaveLength(0);
    expect(workerInstances).toHaveLength(0);
  });

  it("ENABLED=false + Redis → Worker DOES start (for manual jobs) but recurring tick is NOT scheduled", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: false };
    const mod = await import("../workers/instagramCommentPollerWorker.js");
    const handle = mod.startInstagramCommentPollerWorker();
    await handle.close();
    expect(queueInstances).toHaveLength(1);
    expect(workerInstances).toHaveLength(1);
    expect(
      queueAddCalls.find((c) => c.jobName === "poll-instagram-comments"),
    ).toBeUndefined();
  });

  it("ENABLED=true + Redis → Worker starts AND the recurring tick is scheduled", async () => {
    envOverrides = { META_COMMENT_POLLING_ENABLED: true };
    const mod = await import("../workers/instagramCommentPollerWorker.js");
    const handle = mod.startInstagramCommentPollerWorker();
    await handle.close();
    expect(queueInstances).toHaveLength(1);
    expect(queueInstances[0].name).toBe("sp-instagram-comments-poll");
    expect(workerInstances).toHaveLength(1);
    const recurring = queueAddCalls.find(
      (c) => c.jobName === "poll-instagram-comments",
    );
    expect(recurring).toBeDefined();
    expect(recurring.opts?.repeat?.every).toBe(15 * 60_000);
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
