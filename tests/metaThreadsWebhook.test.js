// Meta Threads webhook callback tests — signed_request verification,
// idempotency, and Meta-compliant data-deletion response shape.
//
// We hit the Express router directly via supertest equivalent (just
// import + wrap with express). No real HTTP server.

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import express from "express";

const APP_SECRET = "tsecret";

vi.mock("../config/env.js", () => ({
  env: { THREADS_APP_SECRET: APP_SECRET },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const findFirstMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const draftFindManyMock = vi.fn();
const $transactionMock = vi.fn();

vi.mock("../prisma.js", () => ({
  prisma: {
    channelConnection: {
      findFirst: (...a) => findFirstMock(...a),
      update: (...a) => updateMock(...a),
      delete: (...a) => deleteMock(...a),
    },
    draft: {
      findMany: (...a) => draftFindManyMock(...a),
    },
    rawMetric: { deleteMany: vi.fn() },
    normalizedMetric: { deleteMany: vi.fn() },
    postInsight: { deleteMany: vi.fn() },
    postMetricSnapshot: { deleteMany: vi.fn() },
    postMetrics: { deleteMany: vi.fn() },
    $transaction: (...a) => $transactionMock(...a),
  },
}));

const { metaThreadsWebhookRouter } = await import(
  "../domains/integrations/metaThreadsWebhook.routes.js"
);

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeSignedRequest(payloadObj, secret = APP_SECRET) {
  const payload = base64Url(Buffer.from(JSON.stringify(payloadObj)));
  const sig = base64Url(
    crypto.createHmac("sha256", secret).update(payload).digest()
  );
  return `${sig}.${payload}`;
}

function buildApp() {
  const app = express();
  app.use(metaThreadsWebhookRouter);
  return app;
}

async function postForm(app, path, body) {
  // Light-weight test driver: dispatch through Express's app.handle
  // with mock req/res so we don't need supertest as a dep.
  return new Promise((resolve, reject) => {
    const chunks = [];
    const formBody = new URLSearchParams(body).toString();
    const req = Object.assign(
      Object.create(require("http").IncomingMessage.prototype),
      {
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(formBody),
        },
      }
    );
    // Provide a stream-like body.
    const { Readable } = require("stream");
    const stream = Readable.from([formBody]);
    Object.assign(req, stream);

    const res = Object.assign(Object.create(require("http").ServerResponse.prototype), {
      statusCode: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
      end(buf) {
        const text = buf ? Buffer.concat(chunks.concat([Buffer.from(buf)])).toString("utf8") : Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: this.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: this.statusCode, body: text });
        }
      },
      write(buf) { chunks.push(Buffer.from(buf)); },
      writeHead(status) { this.statusCode = status; },
    });
    res.on = () => {};
    res.removeListener = () => {};
    res.flushHeaders = () => {};

    app.handle(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null })));
  });
}

beforeEach(() => {
  findFirstMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  draftFindManyMock.mockReset();
  $transactionMock.mockReset();
});

describe("deauthorize", () => {
  it("rejects requests with an invalid signature", async () => {
    const bad = "deadbeef.eyJ1c2VyX2lkIjoiOTk5OSJ9";
    const app = buildApp();
    const r = await postForm(app, "/api/webhooks/meta/threads/deauthorize", {
      signed_request: bad,
    });
    expect(r.status).toBe(400);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("revokes the matching connection on a valid signature", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "conn1", clientId: "c1", status: "CONNECTED" });
    updateMock.mockResolvedValueOnce({});

    const sr = makeSignedRequest({ algorithm: "HMAC-SHA256", user_id: "9999" });
    const app = buildApp();
    const r = await postForm(app, "/api/webhooks/meta/threads/deauthorize", {
      signed_request: sr,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledOnce();
    const args = updateMock.mock.calls[0][0];
    expect(args.where).toEqual({ id: "conn1" });
    expect(args.data.status).toBe("REVOKED");
    expect(args.data.accessToken).toBe("");
  });

  it("is idempotent — returns success when no matching connection", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const sr = makeSignedRequest({ algorithm: "HMAC-SHA256", user_id: "ghost" });
    const app = buildApp();
    const r = await postForm(app, "/api/webhooks/meta/threads/deauthorize", {
      signed_request: sr,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("data-deletion", () => {
  it("returns Meta-compliant url + confirmation_code on valid signature", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "conn1", clientId: "c1", status: "CONNECTED" });
    draftFindManyMock.mockResolvedValueOnce([{ id: "d1" }, { id: "d2" }]);
    $transactionMock.mockResolvedValueOnce([{}]);

    const sr = makeSignedRequest({ algorithm: "HMAC-SHA256", user_id: "9999" });
    const app = buildApp();
    const r = await postForm(app, "/api/webhooks/meta/threads/data-deletion", {
      signed_request: sr,
    });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/squadpitch\.com\/data-deletion\/status\/[a-f0-9]{32}$/);
    expect(typeof r.body.confirmation_code).toBe("string");
    expect(r.body.confirmation_code.length).toBe(32);
    expect($transactionMock).toHaveBeenCalledOnce();
  });

  it("is idempotent — returns confirmation_code even when no connection exists", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const sr = makeSignedRequest({ algorithm: "HMAC-SHA256", user_id: "ghost" });
    const app = buildApp();
    const r = await postForm(app, "/api/webhooks/meta/threads/data-deletion", {
      signed_request: sr,
    });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/squadpitch\.com\/data-deletion\/status\/[a-f0-9]{32}$/);
    expect($transactionMock).not.toHaveBeenCalled();
  });

  it("rejects on signature mismatch (different secret)", async () => {
    const sr = makeSignedRequest({ algorithm: "HMAC-SHA256", user_id: "9999" }, "wrong");
    const app = buildApp();
    const r = await postForm(app, "/api/webhooks/meta/threads/data-deletion", {
      signed_request: sr,
    });
    expect(r.status).toBe(400);
    expect($transactionMock).not.toHaveBeenCalled();
  });
});
