import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import { rentcastRequest } from "../domains/industry/providers/rentcast/rentcast.client.js";
import { rentcastProvider } from "../domains/industry/providers/rentcast.provider.js";
import { rentcastPropertyProvider } from "../domains/industry/providers/rentcast/rentcast.provider.js";

const original = {
  enabled: env.RENTCAST_ENABLED,
  apiKey: env.RENTCAST_API_KEY,
};

afterEach(() => {
  env.RENTCAST_ENABLED = original.enabled;
  env.RENTCAST_API_KEY = original.apiKey;
  vi.unstubAllGlobals();
});

describe("RentCast feature toggle", () => {
  it("blocks HTTP requests even when an API key is configured", async () => {
    env.RENTCAST_ENABLED = false;
    env.RENTCAST_API_KEY = "configured-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(rentcastRequest("/properties", { address: "123 Main St" }))
      .rejects.toThrow("disabled by RENTCAST_ENABLED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks both RentCast provider adapters unavailable when disabled", () => {
    env.RENTCAST_ENABLED = false;
    env.RENTCAST_API_KEY = "configured-key";

    expect(rentcastProvider.isAvailable()).toBe(false);
    expect(rentcastPropertyProvider.isAvailable()).toBe(false);
  });
});
