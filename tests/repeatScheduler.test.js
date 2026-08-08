import { describe, expect, it } from "vitest";

import { findDuplicateSchedulerKeys } from "../lib/repeatScheduler.js";

describe("findDuplicateSchedulerKeys", () => {
  it("removes only duplicate schedulers for the same job and cadence", () => {
    const schedulers = [
      { key: "current", name: "poll-scheduled-drafts", every: 60_000 },
      { key: "legacy", name: "poll-scheduled-drafts", every: 60_000 },
      { key: "other-cadence", name: "poll-scheduled-drafts", every: 120_000 },
      { key: "other-job", name: "poll-metrics", every: 60_000 },
    ];

    expect(
      findDuplicateSchedulerKeys(schedulers, {
        keepKey: "current",
        name: "poll-scheduled-drafts",
        every: 60_000,
      }),
    ).toEqual(["legacy"]);
  });
});
