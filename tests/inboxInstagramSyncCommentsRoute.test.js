// POST /api/v1/workspaces/:id/connections/INSTAGRAM/sync-comments
//
// Manual-trigger endpoint for Instagram comment polling. Mirrors
// the Threads + YouTube + Facebook sync-replies/comments routes.
//
// Auth model: in production this endpoint sits behind the global
// /api/* requireAuth middleware (mounted in server.js) plus the
// requireClientOwner middleware which checks `req.auth.payload.sub`
// against `Client.createdBy`. We bypass the JWT verification in
// tests by mocking `getAuth0Sub` and feeding a synthetic actor sub
// via a custom header.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const clients = new Map();
const connections = new Map();
const enqueueCalls = [];
let nextEnqueueBehavior = "ok";
const inlinePollCalls = [];

vi.mock("../prisma.js", () => ({
  prisma: {
    client: {
      findUnique: vi.fn(async ({ where }) => clients.get(where.id) ?? null),
    },
    channelConnection: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.id) {
          for (const row of connections.values()) {
            if (row.id === where.id) return row;
          }
          return null;
        }
        if (where.clientId_channel) {
          const k = `${where.clientId_channel.clientId}:${where.clientId_channel.channel}`;
          return connections.get(k) ?? null;
        }
        return null;
      }),
    },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  getAuth0Sub: (req) => req?.headers?.["x-test-sub"] ?? null,
  requireAuth: (_req, _res, next) => next(),
}));

vi.mock("../workers/instagramCommentPollerWorker.js", () => ({
  enqueueInstagramCommentPollForConnection: vi.fn(async (id) => {
    enqueueCalls.push(id);
    if (nextEnqueueBehavior === "queue-unavailable") {
      throw Object.assign(new Error("Redis is not configured"), {
        code: "QUEUE_UNAVAILABLE",
        status: 503,
      });
    }
    if (nextEnqueueBehavior === "throw") {
      throw new Error("kaboom");
    }
  }),
}));

vi.mock("../domains/inbox/inbox.instagramCommentPoller.service.js", () => ({
  pollInstagramCommentsForConnection: vi.fn(async (conn) => {
    inlinePollCalls.push(conn?.id ?? null);
    return { commentsFetched: 0, messagesCreated: 0, errors: [] };
  }),
}));

const { studioRouter } = await import("../domains/studio/studio.routes.js");

const OWNER_SUB = "auth0|owner-1";
const OTHER_SUB = "auth0|stranger";
const CLIENT_ID = "client-ig-route-1";
const CONN_ID = "conn-ig-route-1";

function seedDefaults() {
  clients.clear();
  connections.clear();
  enqueueCalls.length = 0;
  inlinePollCalls.length = 0;
  nextEnqueueBehavior = "ok";

  clients.set(CLIENT_ID, { id: CLIENT_ID, createdBy: OWNER_SUB });
  connections.set(`${CLIENT_ID}:INSTAGRAM`, {
    id: CONN_ID,
    clientId: CLIENT_ID,
    channel: "INSTAGRAM",
    status: "CONNECTED",
    externalAccountId: "ig-user-456",
  });
}

function buildApp({ withAuth = true } = {}) {
  const app = express();
  app.use(express.json());
  if (withAuth) {
    app.use("/api", (req, res, next) => {
      if (!req.headers["x-test-sub"]) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
      }
      next();
    });
  }
  app.use(studioRouter);
  return app;
}

const URL = `/api/v1/workspaces/${CLIENT_ID}/connections/INSTAGRAM/sync-comments`;

beforeEach(() => {
  seedDefaults();
  vi.clearAllMocks();
});

describe("POST /workspaces/:id/connections/INSTAGRAM/sync-comments", () => {
  it("returns 401 when no auth token is present", async () => {
    const app = buildApp({ withAuth: true });
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(401);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("returns 403 when a stranger requests another tenant's workspace", async () => {
    const app = buildApp({ withAuth: false });
    const res = await request(app)
      .post(URL)
      .set("x-test-sub", OTHER_SUB)
      .send({});
    expect(res.status).toBe(403);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("returns 404 when no Instagram connection exists on the workspace", async () => {
    connections.delete(`${CLIENT_ID}:INSTAGRAM`);
    const app = buildApp({ withAuth: false });
    const res = await request(app)
      .post(URL)
      .set("x-test-sub", OWNER_SUB)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body?.error).toBe("NO_CONNECTION");
    expect(enqueueCalls).toHaveLength(0);
  });

  it("returns 400 when the connection status is not CONNECTED", async () => {
    const row = connections.get(`${CLIENT_ID}:INSTAGRAM`);
    connections.set(`${CLIENT_ID}:INSTAGRAM`, {
      ...row,
      status: "NEEDS_RECONNECT",
    });
    const app = buildApp({ withAuth: false });
    const res = await request(app)
      .post(URL)
      .set("x-test-sub", OWNER_SUB)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body?.error).toBe("CONNECTION_NOT_ACTIVE");
    expect(enqueueCalls).toHaveLength(0);
  });

  it("returns 400 when externalAccountId is missing", async () => {
    const row = connections.get(`${CLIENT_ID}:INSTAGRAM`);
    connections.set(`${CLIENT_ID}:INSTAGRAM`, {
      ...row,
      externalAccountId: null,
    });
    const app = buildApp({ withAuth: false });
    const res = await request(app)
      .post(URL)
      .set("x-test-sub", OWNER_SUB)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body?.error).toBe("NO_USER_ID");
    expect(enqueueCalls).toHaveLength(0);
  });

  it("happy path: 202 + queued shape, enqueue called exactly once", async () => {
    const app = buildApp({ withAuth: false });
    const res = await request(app)
      .post(URL)
      .set("x-test-sub", OWNER_SUB)
      .send({});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "queued",
      connectionId: CONN_ID,
    });
    expect(res.body.message).toMatch(/Instagram comment sync queued/i);
    expect(enqueueCalls).toEqual([CONN_ID]);
    expect(inlinePollCalls).toHaveLength(0);
  });

  it("falls back to inline poll when the queue is unavailable (no Redis)", async () => {
    nextEnqueueBehavior = "queue-unavailable";
    const app = buildApp({ withAuth: false });
    const res = await request(app)
      .post(URL)
      .set("x-test-sub", OWNER_SUB)
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(enqueueCalls).toEqual([CONN_ID]);
    expect(inlinePollCalls).toEqual([CONN_ID]);
  });
});
