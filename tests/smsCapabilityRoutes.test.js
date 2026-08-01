import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { notificationRouter } from "../domains/notifications/notification.routes.js";

const app = express();
app.use(express.json());
app.use(notificationRouter);

describe("SMS capability routes", () => {
  it("reports the authoritative unavailable state", async () => {
    const response = await request(app).get(
      "/api/v1/notifications/capabilities/sms",
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      sms: {
        status: "unavailable",
        availability: "disabled",
        reason: "twilio_account_suspended",
        customerMessage: "SMS is temporarily unavailable.",
      },
    });
  });

  it("rejects the exposed test route without touching a provider", async () => {
    const response = await request(app).post("/api/v1/notifications/test-sms");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "SMS_UNAVAILABLE",
      message: "SMS is temporarily unavailable.",
    });
  });
});
