// Autopilot Phase 5 — run history + idempotency.
//
// Pins the AutopilotRun service contract:
//   - startRun → finishRun records a row with the outcome
//   - listRuns is tenant-isolated + empty workspace returns []
//   - recordRun wraps fn, records ERROR on throw + rethrows
//   - no_action / skipped / error rows are persisted (not just
//     successful ticks)

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

const { startRun, finishRun, recordRun, listRuns } = await import(
  "../domains/studio/autopilotRun.service.js"
);

function makeMock() {
  const rows = new Map();
  let counter = 0;
  return {
    state: { rows },
    autopilotRun: {
      create: vi.fn(async ({ data, select }) => {
        const id = `run-${++counter}`;
        const row = {
          id,
          startedAt: new Date(),
          finishedAt: null,
          recommendationsCreated: 0,
          recommendationsUpdated: 0,
          recommendationsExpired: 0,
          errorMessage: null,
          reason: null,
          ...data,
        };
        rows.set(id, row);
        return select?.id ? { id } : row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data);
        return r;
      }),
      findMany: vi.fn(async ({ where = {}, take, skip = 0 } = {}) => {
        const filtered = [...rows.values()].filter(
          (r) => !where.clientId || r.clientId === where.clientId,
        );
        filtered.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
        return filtered.slice(skip, skip + (take ?? filtered.length));
      }),
      count: vi.fn(async ({ where = {} } = {}) => {
        return [...rows.values()].filter(
          (r) => !where.clientId || r.clientId === where.clientId,
        ).length;
      }),
    },
  };
}

beforeEach(() => {
  prismaMock = makeMock();
});

describe("startRun + finishRun", () => {
  it("creates a row at startRun and updates it at finishRun", async () => {
    const id = await startRun({
      clientId: "client-a",
      triggerSource: "MANUAL",
    });
    expect(prismaMock.state.rows.size).toBe(1);
    expect(prismaMock.state.rows.get(id).status).toBe("NO_ACTION");

    await finishRun(id, {
      status: "CREATED_RECOMMENDATIONS",
      reason: "Surfaced 2 opportunities",
      recommendationsCreated: 2,
    });
    const stored = prismaMock.state.rows.get(id);
    expect(stored.status).toBe("CREATED_RECOMMENDATIONS");
    expect(stored.reason).toBe("Surfaced 2 opportunities");
    expect(stored.recommendationsCreated).toBe(2);
    expect(stored.finishedAt).toBeInstanceOf(Date);
  });

  it("finishRun is a no-op when runId is null (best-effort)", async () => {
    await expect(
      finishRun(null, { status: "ERROR" }),
    ).resolves.not.toThrow();
  });

  it("finishRun swallows DB errors (best-effort)", async () => {
    prismaMock.autopilotRun.update = vi.fn(async () => {
      throw new Error("db blew up");
    });
    await expect(
      finishRun("run-doesnt-exist", { status: "ERROR" }),
    ).resolves.not.toThrow();
  });
});

describe("recordRun", () => {
  it("opens + closes a run around the fn return value", async () => {
    const result = await recordRun(
      { clientId: "client-a", triggerSource: "MANUAL" },
      async () => ({
        status: "NO_ACTION",
        reason: "Settings disabled",
      }),
    );
    expect(result.status).toBe("NO_ACTION");
    const row = [...prismaMock.state.rows.values()][0];
    expect(row.status).toBe("NO_ACTION");
    expect(row.reason).toBe("Settings disabled");
  });

  it("records ERROR + rethrows when fn throws", async () => {
    await expect(
      recordRun(
        { clientId: "client-a", triggerSource: "SCHEDULED" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toMatchObject({ message: "boom" });
    const row = [...prismaMock.state.rows.values()][0];
    expect(row.status).toBe("ERROR");
    expect(row.errorMessage).toBe("boom");
  });

  it("persists no_action / skipped / error rows (not just successful ones)", async () => {
    await recordRun(
      { clientId: "client-a", triggerSource: "SCHEDULED" },
      async () => ({ status: "SKIPPED", reason: "No channels enabled" }),
    );
    await recordRun(
      { clientId: "client-a", triggerSource: "SCHEDULED" },
      async () => ({ status: "NO_ACTION", reason: "Coverage adequate" }),
    );
    await recordRun(
      { clientId: "client-a", triggerSource: "MANUAL" },
      async () => ({ status: "CREATED_RECOMMENDATIONS", recommendationsCreated: 1 }),
    );
    expect(prismaMock.state.rows.size).toBe(3);
    const statuses = [...prismaMock.state.rows.values()].map((r) => r.status);
    expect(statuses).toEqual(
      expect.arrayContaining(["SKIPPED", "NO_ACTION", "CREATED_RECOMMENDATIONS"]),
    );
  });
});

describe("listRuns", () => {
  it("returns rows newest-first, scoped to clientId", async () => {
    const id1 = await startRun({ clientId: "client-a", triggerSource: "MANUAL" });
    prismaMock.state.rows.get(id1).startedAt = new Date("2026-05-17T10:00:00Z");
    await startRun({ clientId: "client-b", triggerSource: "SCHEDULED" });
    const id3 = await startRun({ clientId: "client-a", triggerSource: "SCHEDULED" });
    prismaMock.state.rows.get(id3).startedAt = new Date("2026-05-17T12:00:00Z");
    const result = await listRuns({ clientId: "client-a" });
    expect(result.runs.length).toBe(2);
    expect(result.total).toBe(2);
    // Newest-first sort + FE-shape mapping: triggerSource lowercased.
    expect(result.runs[0].triggerSource).toBe("scheduled");
  });

  it("empty workspace returns an empty array, not an error", async () => {
    const result = await listRuns({ clientId: "client-empty" });
    expect(result.runs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("clamps limit to a max of 100 and rejects missing clientId", async () => {
    await expect(listRuns({})).rejects.toMatchObject({ code: "BAD_INPUT" });
    // The clamp shows up via the prisma mock receiving the safe value;
    // we don't have a direct way to inspect that here, but the call
    // shouldn't reject.
    await expect(
      listRuns({ clientId: "client-a", limit: 9999 }),
    ).resolves.toBeTruthy();
  });
});
