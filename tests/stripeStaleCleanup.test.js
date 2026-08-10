import { describe, expect, it } from "vitest";
import {
  guardedDelete,
  opaqueRef,
} from "../scripts/stripe-stale-cleanup/cleanup.js";

function row(overrides = {}) {
  return {
    id: "local-row",
    userId: "user-private",
    tier: "PRO",
    status: "ACTIVE",
    updatedAt: new Date("2026-07-04T17:31:39.165Z"),
    stripeCustomerId: "cus_stale",
    stripeSubscriptionId: "sub_stale",
    lastStripeEventId: "evt_stale",
    lastStripeEventCreated: 1783186298,
    ...overrides,
  };
}

function expected(value = row()) {
  return {
    ref: opaqueRef(value.userId),
    tier: value.tier,
    updatedAt: value.updatedAt,
    stripeCustomerId: value.stripeCustomerId,
    stripeSubscriptionId: value.stripeSubscriptionId,
    lastStripeEventId: value.lastStripeEventId,
    lastStripeEventCreated: value.lastStripeEventCreated,
  };
}

function database(value = row(), count = 1) {
  let committed = false;
  return {
    get committed() {
      return committed;
    },
    transaction: async (operation) => {
      try {
        const result = await operation({
          findById: async () => value,
          deleteExact: async () => ({ count }),
        });
        committed = true;
        return result;
      } catch (error) {
        committed = false;
        throw error;
      }
    },
  };
}

const absent = async () => ({
  referencesAbsent: true,
  alternativeLiveSubscription: false,
});

describe("guarded stale Stripe billing cleanup", () => {
  it("removes an unchanged stale PRO/ACTIVE row only when Stripe objects are absent", async () => {
    const value = row();
    const db = database(value);
    await expect(
      guardedDelete({
        db,
        stripeState: absent,
        row: value,
        expected: expected(value),
      }),
    ).resolves.toMatchObject({ deleted: true });
    expect(db.committed).toBe(true);
  });

  it("cannot remove a row with a valid live subscription", async () => {
    const value = row();
    const db = database(value);
    await expect(
      guardedDelete({
        db,
        row: value,
        expected: expected(value),
        stripeState: async () => ({
          referencesAbsent: false,
          alternativeLiveSubscription: true,
        }),
      }),
    ).rejects.toThrow("live Stripe state");
    expect(db.committed).toBe(false);
  });

  it("aborts when billing state changed", async () => {
    const original = row();
    await expect(
      guardedDelete({
        db: database(),
        stripeState: absent,
        row: row({ status: "CANCELED" }),
        expected: expected(original),
      }),
    ).rejects.toThrow("billing state changed");
  });

  it("preserves Agency when complimentary/internal intent is ambiguous", async () => {
    const agency = row({ tier: "AGENCY" });
    const db = database(agency);
    await expect(
      guardedDelete({
        db,
        stripeState: absent,
        row: agency,
        expected: expected(agency),
      }),
    ).resolves.toEqual({ deleted: false, reason: "AGENCY_INTENT_AMBIGUOUS" });
    expect(db.committed).toBe(false);
  });

  it("enforces the exact-one-row guard", async () => {
    const value = row();
    const db = database(value, 0);
    await expect(
      guardedDelete({
        db,
        stripeState: absent,
        row: value,
        expected: expected(value),
      }),
    ).rejects.toThrow("exact-one-row guard failed");
    expect(db.committed).toBe(false);
  });

  it("rolls the transaction back on an in-transaction mismatch", async () => {
    const value = row();
    const db = database(row({ updatedAt: new Date("2026-08-10T00:00:00Z") }));
    await expect(
      guardedDelete({
        db,
        stripeState: absent,
        row: value,
        expected: expected(value),
      }),
    ).rejects.toThrow("changed since investigation");
    expect(db.committed).toBe(false);
  });
});
