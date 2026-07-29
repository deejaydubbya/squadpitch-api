import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const constructEvent = vi.fn();
const handleWebhookEvent = vi.fn();

vi.mock("stripe", () => ({
  default: vi.fn(function Stripe() {
    return { webhooks: { constructEvent } };
  }),
}));
vi.mock("../config/env.js", () => ({
  env: {
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
  },
}));
vi.mock("../domains/billing/billing.service.js", () => ({
  handleWebhookEvent,
}));
vi.mock("../domains/billing/aiUsageTracking.service.js", () => ({
  getUsageForPeriod: vi.fn(),
  getAiCostBreakdown: vi.fn(),
}));
vi.mock("../domains/billing/serviceHealth.service.js", () => ({
  getAllServicesHealth: vi.fn(),
  checkBudgetStatus: vi.fn(),
  getThrottlePolicy: vi.fn(),
  setAdminFlag: vi.fn(),
  clearAdminFlag: vi.fn(),
}));

const { billingRouter } = await import("../domains/billing/billing.routes.js");
const app = express();
app.use("/api/v1/billing/webhook", express.raw({ type: "application/json" }));
app.use(billingRouter);

beforeEach(() => {
  constructEvent.mockReset();
  handleWebhookEvent.mockReset();
});

describe("Stripe webhook signature boundary", () => {
  it("rejects a missing signature", async () => {
    await request(app)
      .post("/api/v1/billing/webhook")
      .set("content-type", "application/json")
      .send("{}")
      .expect(400);
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });
    await request(app)
      .post("/api/v1/billing/webhook")
      .set("content-type", "application/json")
      .set("stripe-signature", "invalid")
      .send("{}")
      .expect(400);
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  it("processes only the event returned by signature verification", async () => {
    const verified = {
      id: "evt_verified",
      type: "invoice.paid",
      created: 123,
      data: { object: {} },
    };
    constructEvent.mockReturnValue(verified);
    await request(app)
      .post("/api/v1/billing/webhook")
      .set("content-type", "application/json")
      .set("stripe-signature", "valid")
      .send("{}")
      .expect(200);
    expect(handleWebhookEvent).toHaveBeenCalledWith(verified);
  });
});
