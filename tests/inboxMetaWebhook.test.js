// Meta Inbox webhook receiver — GET verification + POST signed
// event delivery. Both run BEFORE the global auth middleware in
// production, so the only security is the verify-token check
// (GET) and the X-Hub-Signature-256 HMAC check (POST).
//
// Tests boot the router directly in an express app so we can
// hit it with supertest-style requests without spinning the
// whole API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import { createHmac } from "node:crypto";

let envOverrides;
vi.mock("../config/env.js", () => ({
  get env() {
    return envOverrides;
  },
}));

// Ingestion service is stubbed so we can assert what the route
// passes through to it.
const processSpy = vi.fn();
vi.mock("../domains/inbox/inbox.meta.ingestion.service.js", () => ({
  processMetaWebhookPayload: (...args) => processSpy(...args),
}));

const { inboxMetaWebhookRouter } = await import(
  "../domains/inbox/inbox.meta.webhook.routes.js"
);

const VERIFY_TOKEN = "spinstr-test-verify-token";
const APP_SECRET = "test-app-secret-32-bytes-or-more";
const IG_APP_SECRET = "test-ig-app-secret-32-bytes-or-more";
const PATH = "/api/v1/webhooks/meta/inbox";

function bootServer() {
  const app = express();
  app.use(inboxMetaWebhookRouter);
  const server = app.listen(0);
  const port = server.address().port;
  return {
    server,
    request(opts) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: opts.path,
            method: opts.method,
            headers: opts.headers ?? {},
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8");
              resolve({ status: res.statusCode, body, headers: res.headers });
            });
          },
        );
        req.on("error", reject);
        if (opts.body) req.write(opts.body);
        req.end();
      });
    },
  };
}

function signBody(body, secret = APP_SECRET) {
  return (
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
  );
}

beforeEach(() => {
  envOverrides = {
    META_APP_SECRET: APP_SECRET,
    INSTAGRAM_APP_SECRET: IG_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    META_INBOX_INGESTION_ENABLED: false,
  };
  processSpy.mockReset();
  processSpy.mockResolvedValue({
    processed: 1,
    created: 1,
    duplicate: 0,
    skipped: 0,
    reasons: [],
  });
});

// ── GET — subscription verification handshake ──────────────────────────

describe("Meta webhook — GET verification", () => {
  it("returns hub.challenge raw when verify_token matches", async () => {
    const { server, request } = bootServer();
    try {
      const challenge = "12345-meta-challenge";
      const res = await request({
        method: "GET",
        path: `${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${challenge}`,
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe(challenge);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
    } finally {
      server.close();
    }
  });

  it("returns 403 when verify_token is wrong", async () => {
    const { server, request } = bootServer();
    try {
      const res = await request({
        method: "GET",
        path: `${PATH}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`,
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it("returns 400 when hub.mode is missing or non-subscribe", async () => {
    const { server, request } = bootServer();
    try {
      const res = await request({
        method: "GET",
        path: `${PATH}?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`,
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("returns 403 when METAWEBHOOK_VERIFY_TOKEN env is unset", async () => {
    envOverrides.META_WEBHOOK_VERIFY_TOKEN = undefined;
    const { server, request } = bootServer();
    try {
      const res = await request({
        method: "GET",
        path: `${PATH}?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=x`,
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

// ── POST — signature verification ──────────────────────────────────────

describe("Meta webhook — POST signature verification", () => {
  it("returns 403 when signature header is missing", async () => {
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "page", entry: [] });
      const res = await request({
        method: "POST",
        path: PATH,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        body,
      });
      expect(res.status).toBe(403);
      expect(processSpy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("returns 403 when signature is wrong length / wrong value", async () => {
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "page", entry: [] });
      const res = await request({
        method: "POST",
        path: PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body,
      });
      expect(res.status).toBe(403);
      expect(processSpy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("accepts a properly signed body", async () => {
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "page", entry: [] });
      const sig = signBody(body);
      const res = await request({
        method: "POST",
        path: PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-hub-signature-256": sig,
        },
        body,
      });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  // IG-01..06 split Instagram onto its own Meta App (with a separate
  // INSTAGRAM_APP_SECRET) while Facebook stayed on META_APP_SECRET.
  // The dedicated IG app signs its webhooks with INSTAGRAM_APP_SECRET,
  // so the verifier has to accept either secret. Pin both happy paths
  // and the both-secrets-set-but-neither-matches reject path.
  it("accepts a body signed with INSTAGRAM_APP_SECRET (dedicated IG app)", async () => {
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "instagram", entry: [] });
      const sig = signBody(body, IG_APP_SECRET);
      const res = await request({
        method: "POST",
        path: PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-hub-signature-256": sig,
        },
        body,
      });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("still 403s when signature matches neither META nor INSTAGRAM secret", async () => {
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "instagram", entry: [] });
      const sig = signBody(body, "totally-different-secret-xyz-padding-32b");
      const res = await request({
        method: "POST",
        path: PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-hub-signature-256": sig,
        },
        body,
      });
      expect(res.status).toBe(403);
      expect(processSpy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("still 403s when neither secret is configured (env unset)", async () => {
    envOverrides.META_APP_SECRET = undefined;
    envOverrides.INSTAGRAM_APP_SECRET = undefined;
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "page", entry: [] });
      const sig = signBody(body); // signed with APP_SECRET, but env says no secrets
      const res = await request({
        method: "POST",
        path: PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-hub-signature-256": sig,
        },
        body,
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

// ── POST — feature flag gating ─────────────────────────────────────────

describe("Meta webhook — feature flag (META_INBOX_INGESTION_ENABLED)", () => {
  it("does NOT call the ingestion service when flag is off, but still 200s", async () => {
    envOverrides.META_INBOX_INGESTION_ENABLED = false;
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "page", entry: [{ id: "x" }] });
      const sig = signBody(body);
      const res = await request({
        method: "POST",
        path: PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-hub-signature-256": sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      expect(processSpy).not.toHaveBeenCalled();
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(true);
      expect(parsed.ingested).toBe(false);
      expect(parsed.reason).toBe("INGESTION_DISABLED");
    } finally {
      server.close();
    }
  });

  it("calls the ingestion service when flag is on", async () => {
    envOverrides.META_INBOX_INGESTION_ENABLED = true;
    const { server, request } = bootServer();
    try {
      const body = JSON.stringify({ object: "page", entry: [{ id: "p-1" }] });
      const sig = signBody(body);
      const res = await request({
        method: "POST",
        path: PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-hub-signature-256": sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      expect(processSpy).toHaveBeenCalledTimes(1);
      const arg = processSpy.mock.calls[0][0];
      expect(arg.object).toBe("page");
    } finally {
      server.close();
    }
  });
});
