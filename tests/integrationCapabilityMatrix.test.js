import { describe, expect, it } from "vitest";
import {
  CAPABILITY_STATUSES,
  integrationCapabilityMatrix,
  publicIntegrationCapabilities,
  validateIntegrationCapabilityMatrix,
} from "../domains/integrations/integrationCapabilityMatrix.js";

describe("integration production capability matrix", () => {
  it("covers every exposed social provider with valid statuses", () => {
    expect(Object.keys(integrationCapabilityMatrix)).toEqual(
      expect.arrayContaining([
        "FACEBOOK",
        "INSTAGRAM",
        "LINKEDIN",
        "LINKEDIN_ORGANIZATION_PAGE",
        "THREADS",
        "YOUTUBE",
        "GOOGLE_BUSINESS_PROFILE",
        "TIKTOK",
        "PINTEREST",
        "X",
        "REDDIT",
      ]),
    );
    expect(
      validateIntegrationCapabilityMatrix(integrationCapabilityMatrix),
    ).toEqual([]);
  });

  it("does not treat OAuth availability as general product availability", () => {
    expect(integrationCapabilityMatrix.GOOGLE_BUSINESS_PROFILE).toMatchObject({
      connect: "BETA",
      publish: "UNAVAILABLE",
      commentsInbox: "BETA",
    });
    expect(integrationCapabilityMatrix.LINKEDIN).toMatchObject({
      connect: "AVAILABLE",
      commentsInbox: "UNAVAILABLE",
    });
    expect(integrationCapabilityMatrix.REDDIT.overall).toBe("COMING_SOON");
  });

  it("rejects undocumented AVAILABLE connection claims", () => {
    const unsafe = {
      TEST: {
        ...integrationCapabilityMatrix.THREADS,
        approval: "UNVERIFIED",
      },
    };
    expect(validateIntegrationCapabilityMatrix(unsafe)).toContain(
      "TEST.connect cannot be AVAILABLE without documented approval",
    );
  });

  it("returns only the documented public descriptor shape", () => {
    const rows = publicIntegrationCapabilities();
    expect(rows).toHaveLength(11);
    expect(rows[0]).toHaveProperty("provider");
    for (const row of rows) {
      expect(CAPABILITY_STATUSES).toContain(row.overall);
      expect(row).not.toHaveProperty("clientSecret");
    }
  });

  it("reports the implemented Pinterest capability boundaries", () => {
    expect(integrationCapabilityMatrix.PINTEREST).toMatchObject({
      connect: "AVAILABLE",
      boardListing: "AVAILABLE",
      boardCreation: "AVAILABLE",
      mediaPublish: "BETA",
      videoPublish: "UNAVAILABLE",
      tokenRefresh: "AVAILABLE",
      commentsInbox: "UNAVAILABLE",
      analytics: "UNAVAILABLE",
      approval: "DOCUMENTED_STANDARD_ACCESS",
    });
  });
});
