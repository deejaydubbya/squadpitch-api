import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();

vi.mock("../prisma.js", () => ({
  prisma: {
    workspaceDataItem: {
      update,
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const { env } = await import("../config/env.js");
const enrichment = await import(
  "../domains/industry/propertyEnrichment.service.js"
);

const original = {
  NODE_ENV: env.NODE_ENV,
  PROPERTY_API_PROVIDER: env.PROPERTY_API_PROVIDER,
  PROPERTY_ENRICHMENT_ENABLED: env.PROPERTY_ENRICHMENT_ENABLED,
  PROPERTY_SYNTHETIC_DEMO_MODE: env.PROPERTY_SYNTHETIC_DEMO_MODE,
  RENTCAST_ENABLED: env.RENTCAST_ENABLED,
  RENTCAST_API_KEY: env.RENTCAST_API_KEY,
};

beforeEach(() => {
  update.mockReset();
  env.PROPERTY_ENRICHMENT_ENABLED = true;
  env.PROPERTY_SYNTHETIC_DEMO_MODE = false;
  env.RENTCAST_ENABLED = false;
  env.RENTCAST_API_KEY = undefined;
});

afterEach(() => {
  Object.assign(env, original);
  vi.unstubAllGlobals();
});

describe("property enrichment production safety", () => {
  it("allows explicit mock enrichment in tests and records provenance", async () => {
    env.NODE_ENV = "test";
    env.PROPERTY_API_PROVIDER = "mock";

    const result = await enrichment.enrichListing({
      id: "synthetic-item",
      dataJson: { street: "123 Test Street", city: "Testville" },
    });

    expect(result).toMatchObject({ enriched: true, provider: "mock" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "synthetic-item" },
        data: {
          dataJson: expect.objectContaining({
            _enrichmentProvider: "mock",
            _fieldSources: expect.any(Object),
          }),
        },
      }),
    );
  });

  it.each(["production", "staging"])(
    "forbids mock enrichment in %s",
    async (nodeEnv) => {
      env.NODE_ENV = nodeEnv;
      env.PROPERTY_API_PROVIDER = "mock";

      expect(enrichment.getPropertyEnrichmentStatus()).toMatchObject({
        enabled: true,
        ready: false,
        provider: "mock",
      });
      await expect(
        enrichment.enrichListing({
          id: "item-1",
          dataJson: { street: "123 Main Street" },
        }),
      ).rejects.toMatchObject({
        code: "PROPERTY_ENRICHMENT_UNAVAILABLE",
        status: 503,
      });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("rejects missing, malformed, or unavailable real-provider configuration", () => {
    env.NODE_ENV = "production";

    env.PROPERTY_API_PROVIDER = "";
    expect(enrichment.getPropertyEnrichmentStatus().ready).toBe(false);

    env.PROPERTY_API_PROVIDER = "not-a-provider";
    expect(enrichment.getPropertyEnrichmentStatus().ready).toBe(false);

    env.PROPERTY_API_PROVIDER = "rentcast";
    env.RENTCAST_ENABLED = true;
    expect(enrichment.getPropertyEnrichmentStatus()).toMatchObject({
      ready: false,
      provider: "rentcast",
    });
  });

  it("does not fall back to mock when a real provider request fails", async () => {
    env.NODE_ENV = "production";
    env.PROPERTY_API_PROVIDER = "rentcast";
    env.RENTCAST_ENABLED = true;
    env.RENTCAST_API_KEY = "synthetic-test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("provider down")));

    const result = await enrichment.enrichListing({
      id: "item-1",
      dataJson: { street: "123 Main Street" },
    });

    expect(result).toEqual({ enriched: false, fieldsAdded: [], provider: "rentcast" });
    expect(update).not.toHaveBeenCalled();
  });

  it("treats an explicitly disabled optional enrichment feature as ready", () => {
    env.NODE_ENV = "production";
    env.PROPERTY_ENRICHMENT_ENABLED = false;
    env.PROPERTY_API_PROVIDER = "mock";

    expect(enrichment.getPropertyEnrichmentStatus()).toEqual({
      enabled: false,
      ready: true,
      provider: "disabled",
    });
  });

  it("treats the RentCast kill switch as an intentionally disabled optional dependency", () => {
    env.NODE_ENV = "production";
    env.PROPERTY_ENRICHMENT_ENABLED = true;
    env.PROPERTY_API_PROVIDER = "rentcast";
    env.RENTCAST_ENABLED = false;

    expect(enrichment.getPropertyEnrichmentStatus()).toEqual({
      enabled: false,
      ready: true,
      provider: "rentcast-disabled",
    });
  });
});
