import { describe, expect, it, vi } from "vitest";
import { verifyRentCast } from "../scripts/rentcast-verification/index.js";

describe("RentCast production verification", () => {
  it("performs one bounded read and reports only aggregate schema evidence", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: "provider-id" }],
    }));
    const report = await verifyRentCast({ apiKey: "synthetic", fetchImpl });
    expect(report).toEqual({
      provider: "rentcast",
      status: "PASS",
      productionBase: true,
      schemaValid: true,
      requestsMade: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain("provider-id");
  });

  it("rejects missing credentials and non-production endpoints", async () => {
    await expect(verifyRentCast({ apiKey: "" })).rejects.toThrow(
      "not configured",
    );
    await expect(
      verifyRentCast({ apiKey: "synthetic", baseUrl: "https://example.test" }),
    ).rejects.toThrow("production API base URL");
  });

  it("does not expose provider response bodies on failure", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));
    await expect(
      verifyRentCast({ apiKey: "synthetic", fetchImpl }),
    ).rejects.toThrow("HTTP 401");
  });
});
