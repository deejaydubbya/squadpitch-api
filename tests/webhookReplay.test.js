// Verifies the P0.1 fix: replayDelivery() no longer puts the webhook
// signing secret in the BullMQ payload. The job carries only ids/payload;
// the worker fetches the secret from Postgres at execute time.

import { describe, it, expect, vi, beforeEach } from "vitest";

const queueAddMock = vi.fn().mockResolvedValue({ id: "job-1" });

vi.mock("../prisma.js", () => ({
  prisma: {
    webhookDeliveryLog: {
      findUnique: vi.fn().mockResolvedValue({
        id: "delivery-1",
        status: "failed",
        eventType: "POST_PUBLISHED",
        requestBody: { example: true },
        webhook: {
          id: "hook-1",
          targetUrl: "https://example.com/hook",
          // The DB row carries the secret. The job payload must not.
          secret: "whsec_super_secret_value",
          isActive: true,
          userId: "user-1",
        },
      }),
    },
  },
}));

vi.mock("../lib/queues.js", () => ({
  getNotificationQueue: () => ({ add: queueAddMock }),
}));

const { replayDelivery } = await import(
  "../domains/internal/webhooks.service.js"
);

describe("replayDelivery — secret leak guard (P0.1 regression)", () => {
  beforeEach(() => {
    queueAddMock.mockClear();
  });

  it("queues a job without the signing secret in the payload", async () => {
    await replayDelivery("delivery-1");

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [jobName, payload] = queueAddMock.mock.calls[0];

    expect(jobName).toBe("send-notification-webhook");

    // The whole point: no `secret` key in the BullMQ payload.
    expect(payload).not.toHaveProperty("secret");

    // And the secret string must not appear anywhere in the payload tree —
    // not under a different key, not stringified, not nested.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("whsec_super_secret_value");

    // The job must still carry the identifiers the worker needs.
    expect(payload).toMatchObject({
      webhookId: "hook-1",
      eventType: "POST_PUBLISHED",
      userId: "user-1",
      replayOfId: "delivery-1",
    });
  });
});
