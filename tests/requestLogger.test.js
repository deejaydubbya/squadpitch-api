// Request-logger configuration smoke tests:
//   - REDACT_PATHS includes the obvious secrets surfaces
//   - resolveClientId pulls from the workspaces path
//   - resolveClientId falls back to body.clientId when present

import { describe, it, expect } from "vitest";
import { _internal } from "../lib/requestLogger.js";

describe("REDACT_PATHS", () => {
  it("covers Authorization, Cookie, and common body secrets", () => {
    const paths = _internal.REDACT_PATHS;
    // Headers
    expect(paths).toEqual(
      expect.arrayContaining([
        'req.headers["authorization"]',
        'req.headers["cookie"]',
        'res.headers["set-cookie"]',
      ])
    );
    // Bodies
    expect(paths).toEqual(
      expect.arrayContaining([
        "req.body.password",
        "req.body.secret",
        "req.body.accessToken",
        "req.body.refreshToken",
        "req.body.apiKey",
        "req.body.clientSecret",
      ])
    );
  });
});

describe("resolveClientId", () => {
  it("extracts from /api/v1/workspaces/:id paths", () => {
    expect(
      _internal.resolveClientId({ url: "/api/v1/workspaces/ws-1/drafts" })
    ).toBe("ws-1");
  });

  it("falls back to body.clientId when path doesn't match", () => {
    expect(
      _internal.resolveClientId({ url: "/api/v1/generate", body: { clientId: "ws-2" } })
    ).toBe("ws-2");
  });

  it("returns undefined when neither is present", () => {
    expect(_internal.resolveClientId({ url: "/api/v1/billing/usage" })).toBeUndefined();
  });

  it("ignores malformed body shapes", () => {
    expect(_internal.resolveClientId({ url: "/x", body: null })).toBeUndefined();
    expect(_internal.resolveClientId({ url: "/x", body: 42 })).toBeUndefined();
  });
});
