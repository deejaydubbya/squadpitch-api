import { describe, expect, it } from "vitest";
import {
  isStopRequest,
  twilioDeliveryFailure,
  validateTwilioProductionConfig,
} from "../domains/inbox/twilioSafety.js";

const valid = {
  SMS_SENDING_ENABLED: true,
  SMS_A2P_APPROVED: true,
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "a".repeat(32),
  TWILIO_FROM_NUMBER: "+15551234567",
  TWILIO_MESSAGING_SERVICE_SID: `MG${"b".repeat(32)}`,
  TWILIO_INBOUND_WEBHOOK_URL:
    "https://api.example.test/api/v1/inbox/webhooks/twilio/inbound",
  TWILIO_STATUS_CALLBACK_URL:
    "https://api.example.test/api/v1/inbox/webhooks/twilio/status",
};

describe("Twilio production safety", () => {
  it("keeps incomplete SMS configuration safe while sending is disabled", () => {
    expect(
      validateTwilioProductionConfig({
        SMS_SENDING_ENABLED: false,
        SMS_A2P_APPROVED: false,
      }),
    ).toEqual([]);
  });

  it("validates all compliance and webhook requirements when enabled", () => {
    expect(validateTwilioProductionConfig(valid)).toEqual([]);
    expect(
      validateTwilioProductionConfig({
        ...valid,
        SMS_A2P_APPROVED: false,
        TWILIO_FROM_NUMBER: "5551234567",
        TWILIO_STATUS_CALLBACK_URL: "http://localhost/status",
      }),
    ).toEqual(
      expect.arrayContaining([
        "SMS_SENDING_ENABLED requires SMS_A2P_APPROVED=true",
        "TWILIO_FROM_NUMBER must be in E.164 format",
        "TWILIO_STATUS_CALLBACK_URL must be a credential-free HTTPS URL",
      ]),
    );
  });

  it("recognizes provider and fallback STOP commands without auto opt-in", () => {
    expect(isStopRequest({ OptOutType: "STOP", Body: "BAJA" })).toBe(true);
    expect(isStopRequest({ Body: "unsubscribe" })).toBe(true);
    expect(isStopRequest({ OptOutType: "START", Body: "START" })).toBe(false);
    expect(isStopRequest({ OptOutType: "HELP", Body: "HELP" })).toBe(false);
  });

  it("classifies only terminal delivery failures", () => {
    expect(twilioDeliveryFailure("undelivered")).toBe(true);
    expect(twilioDeliveryFailure("failed")).toBe(true);
    expect(twilioDeliveryFailure("delivered")).toBe(false);
    expect(twilioDeliveryFailure("sent")).toBe(false);
  });
});
