// Sentry helper smoke tests. We never want SENTRY_DSN being unset to
// crash boot, error handling, or any request path.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { SENTRY_DSN: undefined, NODE_ENV: "test" },
}));

const { initSentry, sentryRequestHandler, sentryErrorHandler, captureException, redactSentryEvent, _resetSentryForTest } =
  await import("../lib/sentry.js");

beforeEach(() => {
  _resetSentryForTest();
});

describe("initSentry without DSN", () => {
  it("returns false and does not throw", async () => {
    const ok = await initSentry();
    expect(ok).toBe(false);
  });
});

describe("middleware no-ops when SENTRY_DSN is unset", () => {
  it("requestHandler calls next() and does nothing else", () => {
    const next = vi.fn();
    sentryRequestHandler()({}, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("errorHandler forwards err via next()", () => {
    const next = vi.fn();
    const err = new Error("x");
    sentryErrorHandler()(err, {}, {}, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe("captureException is a safe no-op without DSN", () => {
  it("does not throw", () => {
    expect(() => captureException(new Error("boom"))).not.toThrow();
  });
});

describe("Sentry privacy redaction", () => {
  it("removes credentials, content, and user PII while preserving safe dimensions", () => {
    const event = redactSentryEvent({
      request: { headers: { authorization: "Bearer secret" }, cookies: { session: "secret" }, data: "customer content", url: "/route?code=oauth-secret" },
      user: { id: "user-id", email: "person@example.com", ip_address: "127.0.0.1" },
      extra: { workspaceId: "workspace-id", provider: "stripe", accessToken: "secret" },
    });
    expect(event.request).toEqual({ url: "/route" });
    expect(event.user).toEqual({ id: "user-id" });
    expect(event.extra.accessToken).toBe("[Filtered]");
    expect(JSON.stringify(event)).not.toContain("Bearer secret");
    expect(JSON.stringify(event)).not.toContain("person@example.com");
    expect(JSON.stringify(event)).not.toContain("oauth-secret");
  });
});
