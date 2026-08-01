import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    notificationLog: { update: vi.fn(async () => ({})) },
  },
}));

vi.mock("../domains/notifications/providers/twilioSmsProvider.js", () => ({
  sendSms: vi.fn(),
}));

const { SMS_AVAILABILITY, SmsUnavailableError, assertSmsAvailable } =
  await import("../domains/sms/smsAvailability.js");
const { processJob } = await import("../workers/notificationWorker.js");
const { sendSms } =
  await import("../domains/notifications/providers/twilioSmsProvider.js");

describe("authoritative SMS disablement", () => {
  it("reports the suspended provider capability as disabled", () => {
    expect(SMS_AVAILABILITY).toEqual({
      status: "unavailable",
      availability: "disabled",
      reason: "twilio_account_suspended",
      customerMessage: "SMS is temporarily unavailable.",
    });
    expect(() => assertSmsAvailable()).toThrow(SmsUnavailableError);
  });

  it("stops a legacy queued SMS job without calling Twilio or retrying", async () => {
    await expect(
      processJob({
        name: "send-notification-sms",
        data: {
          logId: "legacy-log",
          phoneNumber: "redacted",
          eventType: "POST_FAILED",
          payload: {},
        },
      }),
    ).resolves.toEqual({ skipped: true, code: "SMS_UNAVAILABLE" });
    expect(sendSms).not.toHaveBeenCalled();
  });
});
