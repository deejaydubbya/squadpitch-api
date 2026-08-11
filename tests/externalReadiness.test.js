import { describe, expect, it, vi } from "vitest";
import { verifyExternalReadiness } from "../scripts/uptime/verify.js";

describe("external readiness verifier", () => {
  it("passes only expected HTTP statuses without returning response bodies", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const report = await verifyExternalReadiness({
      checks: [["api", "https://example.test/ready", [200]]],
      fetchImpl,
    });
    expect(report.status).toBe("PASS");
    expect(report.results[0]).toMatchObject({ id: "api", httpStatus: 200 });
    expect(JSON.stringify(report)).not.toContain("body");
  });

  it("fails closed on unexpected status or network failure", async () => {
    const responses = [
      async () => ({ status: 503 }),
      async () => {
        throw new Error("private detail");
      },
    ];
    const report = await verifyExternalReadiness({
      checks: [
        ["api", "https://example.test/ready", [200]],
        ["ai", "https://ai.test/ready", [200]],
      ],
      fetchImpl: vi.fn((...args) => responses.shift()(...args)),
    });
    expect(report.status).toBe("FAIL");
    expect(report.results.map((item) => item.status)).toEqual(["FAIL", "FAIL"]);
    expect(JSON.stringify(report)).not.toContain("private detail");
  });
});
