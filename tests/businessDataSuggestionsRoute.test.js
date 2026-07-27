import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const clientFindUnique = vi.fn();
const dataGroupBy = vi.fn();
const dataCount = vi.fn();

vi.mock("../prisma.js", () => ({
  prisma: {
    client: { findUnique: clientFindUnique },
    workspaceDataItem: {
      groupBy: dataGroupBy,
      count: dataCount,
    },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  getAuth0Sub: (req) => req.headers["x-test-sub"] ?? null,
  requireAuth: (_req, _res, next) => next(),
}));

const { studioRouter } = await import("../domains/studio/studio.routes.js");

const CLIENT_ID = "client-data-suggestions";
const OWNER_SUB = "auth0|data-owner";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(studioRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  clientFindUnique.mockImplementation(async ({ select }) => {
    if (select?.createdBy) return { createdBy: OWNER_SUB };
    return { industryKey: "real_estate" };
  });
  dataGroupBy.mockResolvedValue([]);
  dataCount.mockResolvedValue(0);
});

describe("GET /workspaces/:id/business-data/suggestions", () => {
  it("reaches the collection handler instead of treating suggestions as an item ID", async () => {
    const response = await request(buildApp())
      .get(`/api/v1/workspaces/${CLIENT_ID}/business-data/suggestions`)
      .set("x-test-sub", OWNER_SUB);

    expect(response.status).toBe(200);
    expect(response.body.suggestions).toEqual([
      expect.objectContaining({ id: "no_data", type: "no_data" }),
    ]);
    expect(dataGroupBy).toHaveBeenCalledOnce();
    expect(dataCount).toHaveBeenCalledTimes(4);
  });
});
