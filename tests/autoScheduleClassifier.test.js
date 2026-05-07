// Auto-schedule rejected-count classifier — pure function, so this is
// straight arithmetic + the public-facing message contract.

import { describe, it, expect } from "vitest";
import { classifyAutoScheduleResult } from "../domains/studio/autoScheduleClassifier.js";

describe("classifyAutoScheduleResult", () => {
  it("returns zero rejections when every submitted id is owned and scheduled", () => {
    const r = classifyAutoScheduleResult({
      submittedIds: ["a", "b", "c"],
      ownedIdSet: new Set(["a", "b", "c"]),
      scheduledCount: 3,
    });
    expect(r.ownershipRejected).toBe(0);
    expect(r.stateRejected).toBe(0);
    expect(r.rejectedCount).toBe(0);
    expect(r.rejectedReason).toBeNull();
    expect(r.ownedIds).toEqual(["a", "b", "c"]);
  });

  it("counts cross-workspace ids as ownership rejections", () => {
    // submitted 4, only 2 owned, both scheduled — 2 ownership rejections, 0 state.
    const r = classifyAutoScheduleResult({
      submittedIds: ["a", "b", "x", "y"],
      ownedIdSet: new Set(["a", "b"]),
      scheduledCount: 2,
    });
    expect(r.ownershipRejected).toBe(2);
    expect(r.stateRejected).toBe(0);
    expect(r.rejectedCount).toBe(2);
    expect(r.ownedIds).toEqual(["a", "b"]);
  });

  it("counts owned-but-unschedulable ids as state rejections", () => {
    // 3 owned, only 1 scheduled (e.g. 2 already PUBLISHED).
    const r = classifyAutoScheduleResult({
      submittedIds: ["a", "b", "c"],
      ownedIdSet: new Set(["a", "b", "c"]),
      scheduledCount: 1,
    });
    expect(r.ownershipRejected).toBe(0);
    expect(r.stateRejected).toBe(2);
    expect(r.rejectedCount).toBe(2);
  });

  it("sums ownership + state rejections", () => {
    const r = classifyAutoScheduleResult({
      submittedIds: ["a", "b", "x"],
      ownedIdSet: new Set(["a", "b"]),
      scheduledCount: 1,
    });
    expect(r.ownershipRejected).toBe(1);
    expect(r.stateRejected).toBe(1);
    expect(r.rejectedCount).toBe(2);
  });

  it("returns generic rejectedReason that does NOT mention ownership", () => {
    // Critical contract: the message must not let a caller infer that
    // their request hit a cross-workspace id. We probe the wording.
    const r = classifyAutoScheduleResult({
      submittedIds: ["a", "x"],
      ownedIdSet: new Set(["a"]),
      scheduledCount: 1,
    });
    expect(r.rejectedReason).toBeTruthy();
    expect(r.rejectedReason).not.toMatch(/workspace/i);
    expect(r.rejectedReason).not.toMatch(/owner/i);
    expect(r.rejectedReason).not.toMatch(/permission/i);
    expect(r.rejectedReason).not.toMatch(/forbidden/i);
  });

  it("preserves submission order in ownedIds (so slot mapping stays stable)", () => {
    const r = classifyAutoScheduleResult({
      submittedIds: ["c", "a", "x", "b"],
      ownedIdSet: new Set(["a", "b", "c"]),
      scheduledCount: 3,
    });
    expect(r.ownedIds).toEqual(["c", "a", "b"]);
  });

  it("handles empty input cleanly", () => {
    const r = classifyAutoScheduleResult({
      submittedIds: [],
      ownedIdSet: new Set(),
      scheduledCount: 0,
    });
    expect(r.rejectedCount).toBe(0);
    expect(r.rejectedReason).toBeNull();
  });
});
