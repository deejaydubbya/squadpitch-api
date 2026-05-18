// Twilio inbound webhook — X-Twilio-Signature verification.
//
// Pins the four cases spinstr422 spec'd:
//   1. valid signature → STOP recorded
//   2. missing signature → 403, no DB write
//   3. invalid signature → 403, no DB write
//   4. DB never touched on either reject path
//
// We don't mount the full express app — we drive the handler
// directly with fake req/res shims, mocking prisma and the
// twilio SDK at module scope so the route's lazy imports return
// our doubles. Signature math is exercised against real Twilio
// SDK output so the test catches a regression in either
// direction (we change the URL, the canonicalization, etc.).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";

const AUTH_TOKEN = "test-auth-token-xyz";
const WEBHOOK_URL = "https://squadpitch-api.fly.dev/api/v1/inbox/webhooks/twilio/inbound";

let prismaMock;
let updateCalls;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../config/env.js", () => ({
  get env() {
    // Include the auth middleware's required fields so the
    // router can import cleanly. We never actually hit an
    // auth-gated route in this file.
    return {
      AUTH0_AUDIENCE: "test-audience",
      AUTH0_DOMAIN: "test.auth0.com",
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_INBOUND_WEBHOOK_URL: WEBHOOK_URL,
    };
  },
}));

beforeEach(() => {
  updateCalls = [];
  prismaMock = {
    contact: {
      findMany: vi.fn(async ({ where }) => {
        if (where?.phone === "+15551234567") {
          return [{ id: "contact-1", enrichmentJson: null }];
        }
        return [];
      }),
      update: vi.fn(async (args) => {
        updateCalls.push(args);
        return { id: args.where.id, ...args.data };
      }),
    },
  };
});

// Build the same X-Twilio-Signature the real Twilio backend would
// send for a given body. The official SDK has a getExpectedTwilioSignature
// helper for tests.
function signRequest(params) {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, WEBHOOK_URL, params);
}

// Build an express app with ONLY the inbox router mounted, so
// we don't drag in 60+ unrelated route modules + middleware.
async function buildApp() {
  // Lazy import — picks up the prisma + env mocks above.
  const { inboxRouter } = await import("../domains/inbox/inbox.routes.js");
  const app = express();
  app.use(inboxRouter);
  return app;
}

describe("Twilio inbound webhook — signature verification", () => {
  it("accepts a valid signature and records STOP opt-out", async () => {
    const app = await buildApp();
    const body = { From: "+15551234567", Body: "STOP" };
    const sig = signRequest(body);
    const res = await request(app)
      .post("/api/v1/inbox/webhooks/twilio/inbound")
      .set("X-Twilio-Signature", sig)
      .type("form")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toContain("<Response></Response>");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].data.enrichmentJson.smsOptOut).toBe(true);
  });

  it("rejects with 403 when the X-Twilio-Signature header is missing", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/api/v1/inbox/webhooks/twilio/inbound")
      .type("form")
      .send({ From: "+15551234567", Body: "STOP" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("MISSING_SIGNATURE");
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects with 403 when the signature is invalid", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/api/v1/inbox/webhooks/twilio/inbound")
      .set("X-Twilio-Signature", "obviously-not-a-real-signature")
      .type("form")
      .send({ From: "+15551234567", Body: "STOP" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("INVALID_SIGNATURE");
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects with 403 when the body has been tampered with after signing", async () => {
    const app = await buildApp();
    const signedBody = { From: "+15551234567", Body: "STOP" };
    const sig = signRequest(signedBody);
    // Send the original signature but a different Body. Twilio's
    // HMAC must catch the mismatch.
    const res = await request(app)
      .post("/api/v1/inbox/webhooks/twilio/inbound")
      .set("X-Twilio-Signature", sig)
      .type("form")
      .send({ From: "+15551234567", Body: "DIFFERENT" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("INVALID_SIGNATURE");
    expect(updateCalls).toHaveLength(0);
  });

  it("does not record opt-out when the message body isn't a STOP-family command", async () => {
    const app = await buildApp();
    const body = { From: "+15551234567", Body: "hi there" };
    const sig = signRequest(body);
    const res = await request(app)
      .post("/api/v1/inbox/webhooks/twilio/inbound")
      .set("X-Twilio-Signature", sig)
      .type("form")
      .send(body);
    // Valid sig → 200, but no contact write because the body
    // isn't STOP/STOPALL/etc.
    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(0);
  });
});
