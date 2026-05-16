// Google Business Profile OAuth — buildAuthUrl + exchangeCode.
//
// Pinning the OAuth URL contract (spinstr413 task F.1, F.2):
//   - business.manage scope is requested.
//   - access_type=offline so we get a refresh token.
//   - prompt=consent so Google re-issues the refresh token on
//     repeat authorizations.
//   - exchangeCode returns the tokenBundle shape the connection
//     service expects, and externalAccountId is the "accounts/{a}"
//     sentinel (the location picker upgrades it later).

import { describe, it, expect, vi, beforeEach } from "vitest";

let envOverrides = {};
vi.mock("../config/env.js", () => ({
  get env() {
    return envOverrides;
  },
}));

const oauth = await import(
  "../domains/studio/oauth/googleBusinessProfile.oauth.js"
);

const REDIRECT = "https://app.squadpitch.com/oauth/GOOGLE_BUSINESS_PROFILE/callback";

beforeEach(() => {
  envOverrides = {
    GOOGLE_BUSINESS_PROFILE_CLIENT_ID: "client-abc",
    GOOGLE_BUSINESS_PROFILE_CLIENT_SECRET: "secret-xyz",
    GOOGLE_BUSINESS_PROFILE_REDIRECT_URI: REDIRECT,
  };
});

describe("buildAuthUrl", () => {
  it("requests business.manage scope + offline access + consent prompt", () => {
    const url = new URL(oauth.buildAuthUrl({ state: "state-123" }));
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/business.manage",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("throws GBP_NOT_CONFIGURED when client credentials are missing", () => {
    envOverrides.GOOGLE_BUSINESS_PROFILE_CLIENT_ID = undefined;
    expect(() => oauth.buildAuthUrl({ state: "x" })).toThrowError(
      /credentials not configured/i,
    );
  });
});

describe("exchangeCode", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it("exchanges the code for access + refresh tokens and returns the accounts/{a} sentinel", async () => {
    fetchMock.mockImplementationOnce(async (url) => {
      expect(url).toContain("oauth2.googleapis.com/token");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "AT-1",
          refresh_token: "RT-1",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/business.manage",
          token_type: "Bearer",
        }),
      };
    });
    fetchMock.mockImplementationOnce(async (url) => {
      expect(url).toContain("/v1/accounts");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accounts: [
            { name: "accounts/100", accountName: "Acme Co" },
          ],
        }),
      };
    });

    const bundle = await oauth.exchangeCode({ code: "auth-code-xyz" });
    expect(bundle.accessToken).toBe("AT-1");
    expect(bundle.refreshToken).toBe("RT-1");
    // externalAccountId is the SENTINEL — picker upgrades it.
    expect(bundle.externalAccountId).toBe("accounts/100");
    expect(bundle.externalAccountId).not.toContain("/locations/");
    expect(bundle.displayName).toBe("Acme Co");
    expect(bundle.scopes).toContain("https://www.googleapis.com/auth/business.manage");
    // tokenExpiresAt is a Date roughly 1 hour out.
    expect(bundle.tokenExpiresAt).toBeInstanceOf(Date);
    expect(bundle.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("surfaces Google's error verbatim on a non-2xx token exchange", async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: "invalid_grant",
        error_description: "Bad code",
      }),
    }));
    await expect(oauth.exchangeCode({ code: "bad" })).rejects.toMatchObject({
      code: "GBP_OAUTH_FAILED",
      message: "Bad code",
    });
  });

  it("re-throws GBP_OAUTH_FAILED when accounts.list returns 403", async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "AT-2",
        refresh_token: "RT-2",
        expires_in: 3600,
      }),
    }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "Permission denied" } }),
    }));
    await expect(oauth.exchangeCode({ code: "ok" })).rejects.toMatchObject({
      code: "GBP_OAUTH_FAILED",
      status: 403,
    });
  });
});

describe("refreshAccessToken", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it("posts to /token with refresh_token grant_type", async () => {
    fetchMock.mockImplementationOnce(async (url, opts) => {
      expect(url).toContain("oauth2.googleapis.com/token");
      const params = new URLSearchParams(opts.body);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("RT-1");
      expect(params.get("client_id")).toBe("client-abc");
      return {
        ok: true,
        json: async () => ({ access_token: "AT-NEW", expires_in: 3600 }),
      };
    });
    const result = await oauth.refreshAccessToken({ refreshToken: "RT-1" });
    expect(result.accessToken).toBe("AT-NEW");
    expect(result.expiresIn).toBe(3600);
  });
});
