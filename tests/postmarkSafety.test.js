import { describe, expect, it } from "vitest";
import {
  requireSuccessfulPostmarkResponse,
  validatePostmarkProductionConfig,
} from "../domains/inbox/postmarkSafety.js";

const valid = {
  NOTIFICATION_FROM_EMAIL: "notifications@squadpitch.com",
  INBOX_EMAIL_FROM: "inbox@mail.squadpitch.com",
  INBOX_EMAIL_REPLY_DOMAIN: "mail.squadpitch.com",
  POSTMARK_MESSAGE_STREAM: "outbound",
  POSTMARK_INBOUND_WEBHOOK_SECRET: "a".repeat(48),
};

describe("Postmark production safety", () => {
  it("accepts the complete email configuration", () => {
    expect(validatePostmarkProductionConfig(valid)).toEqual([]);
  });

  it("rejects malformed senders, domain, stream, and short secret", () => {
    const errors = validatePostmarkProductionConfig({
      NOTIFICATION_FROM_EMAIL: "bad",
      INBOX_EMAIL_FROM: "",
      INBOX_EMAIL_REPLY_DOMAIN: "localhost",
      POSTMARK_MESSAGE_STREAM: "Not Valid!",
      POSTMARK_INBOUND_WEBHOOK_SECRET: "short",
    });
    expect(errors).toHaveLength(5);
  });

  it("requires ErrorCode zero and a provider message ID", () => {
    expect(
      requireSuccessfulPostmarkResponse({
        ErrorCode: 0,
        MessageID: "pm-message",
      }).MessageID,
    ).toBe("pm-message");
    expect(() =>
      requireSuccessfulPostmarkResponse({
        ErrorCode: 406,
        Message: "Inactive",
      }),
    ).toThrow("Inactive");
    expect(() => requireSuccessfulPostmarkResponse({ ErrorCode: 0 })).toThrow(
      /message ID/,
    );
  });
});
