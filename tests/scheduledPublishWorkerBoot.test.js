import { beforeEach, describe, expect, it, vi } from "vitest";

const removedSchedulerKeys = [];
const workerInstances = [];

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    async add() {
      return { repeatJobKey: "current" };
    }

    async getJobSchedulers() {
      return [
        { key: "current", name: "poll-scheduled-drafts", every: 60_000 },
        { key: "legacy", name: "poll-scheduled-drafts", every: 60_000 },
        { key: "unrelated", name: "other-job", every: 60_000 },
      ];
    }

    async removeJobScheduler(key) {
      removedSchedulerKeys.push(key);
    }

    async close() {}
  },
  Worker: class FakeWorker {
    constructor() {
      workerInstances.push(this);
    }

    on() {}

    async close() {}
  },
}));

vi.mock("../redis.js", () => ({
  getRedisConnection: () => ({ __fake: true }),
}));

vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("../domains/studio/publishing/publishingService.js", () => ({
  publishDraft: vi.fn(),
}));
vi.mock("../domains/studio/draftWorkflow.service.js", () => ({
  transitionDraft: vi.fn(),
}));
vi.mock("../lib/opsAlert.js", () => ({ sendOpsAlert: vi.fn() }));

describe("scheduled publish worker startup", () => {
  beforeEach(() => {
    removedSchedulerKeys.length = 0;
    workerInstances.length = 0;
  });

  it("removes the legacy duplicate before starting the worker", async () => {
    const { startScheduledPublishWorker } = await import(
      "../workers/scheduledPublishWorker.js"
    );

    const resource = await startScheduledPublishWorker();

    expect(removedSchedulerKeys).toEqual(["legacy"]);
    expect(workerInstances).toHaveLength(1);
    await resource.close();
  });
});
