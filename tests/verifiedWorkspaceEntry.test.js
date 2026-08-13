import { describe, expect, it, vi } from "vitest";
import { requireAuthoritativeVerifiedEmail, resendAuth0Verification, resolveAuthoritativeIdentity } from "../lib/auth0Identity.js";

const request = (payload = {}) => ({ auth: { token: "access-token", payload: { sub: "auth0|user", ...payload } } });

describe("authoritative verified workspace entry", () => {
  it("does not trust a stale verified JWT when userinfo is currently unverified", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sub: "auth0|user", email: "User@Example.com", email_verified: false }) });
    await expect(resolveAuthoritativeIdentity(request({ email_verified: true }), fetchImpl)).resolves.toMatchObject({ email: "user@example.com", emailVerified: false });
  });

  it("observes newly verified state immediately from Auth0 userinfo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sub: "auth0|user", email: "User@Example.com", email_verified: true }) });
    await expect(resolveAuthoritativeIdentity(request({ email_verified: false }), fetchImpl)).resolves.toMatchObject({ email: "user@example.com", emailVerified: true });
  });

  it("rejects an unverified identity at the server mutation boundary", async () => {
    const previous = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: "user@example.com", email_verified: false }) });
    await expect(requireAuthoritativeVerifiedEmail(request())).rejects.toMatchObject({ code: "VERIFIED_EMAIL_REQUIRED", status: 403 });
    global.fetch = previous;
  });

  it("resends through dedicated server-side Auth0 management credentials", async () => {
    const previousId = process.env.AUTH0_MANAGEMENT_CLIENT_ID;
    const previousSecret = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;
    process.env.AUTH0_MANAGEMENT_CLIENT_ID = "management-client";
    process.env.AUTH0_MANAGEMENT_CLIENT_SECRET = "management-secret";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "auth0|user", email: "user@example.com", email_verified: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "management-token" }) })
      .mockResolvedValueOnce({ ok: true });

    await expect(resendAuth0Verification(request(), fetchImpl)).resolves.toEqual({ sent: true, alreadyVerified: false });
    expect(fetchImpl).toHaveBeenLastCalledWith(expect.stringContaining("/api/v2/jobs/verification-email"), expect.objectContaining({
      body: JSON.stringify({ user_id: "auth0|user" }),
    }));

    if (previousId === undefined) delete process.env.AUTH0_MANAGEMENT_CLIENT_ID;
    else process.env.AUTH0_MANAGEMENT_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;
    else process.env.AUTH0_MANAGEMENT_CLIENT_SECRET = previousSecret;
  });
});
