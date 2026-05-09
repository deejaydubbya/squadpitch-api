// LinkedIn Organization Page — OAuth + adapter + page-fetcher tests.
//
// Covers:
//   - org OAuth: not_configured error if creds missing
//   - org OAuth: scope set comes from env (default + override)
//   - org OAuth: authorization URL uses the ORG client_id, not personal
//   - org OAuth: product-not-approved error mapped to user-facing copy
//   - listManageableOrganizations parses LinkedIn's response shape
//   - listManageableOrganizations: empty → [] (UI message handled at route)
//   - listManageableOrganizations: 401/403 → typed permission error
//   - org adapter: refuses to publish if connection has no org URN
//   - org adapter: posts with the org URN as author (not member)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV = {
  LINKEDIN_ORG_CLIENT_ID: "org-client-id",
  LINKEDIN_ORG_CLIENT_SECRET: "org-client-secret",
  LINKEDIN_ORG_REDIRECT_URI: "https://app.squadpitch.com/oauth/LINKEDIN_ORG/callback",
  LINKEDIN_ORG_SCOPES: "r_organization_admin,w_organization_social,r_organization_social",
};

vi.mock("../config/env.js", () => ({
  env: { ...ENV },
}));

const prismaMock = {
  channelConnection: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../lib/tokenCrypto.js", () => ({
  decryptToken: (s) => `decrypted:${s}`,
}));

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("linkedinOrg.oauth — buildAuthUrl", () => {
  it("uses the ORG client_id (not the personal one) and the configured scopes", async () => {
    const { buildAuthUrl } = await import(
      "../domains/studio/oauth/linkedinOrg.oauth.js"
    );
    const url = buildAuthUrl({ state: "abc" });
    expect(url).toContain("client_id=org-client-id");
    expect(url).toContain(
      "scope=r_organization_admin+w_organization_social+r_organization_social"
    );
    expect(url).toContain("redirect_uri=https%3A%2F%2Fapp.squadpitch.com");
  });

  it("throws LINKEDIN_ORG_NOT_CONFIGURED when creds are missing", async () => {
    vi.resetModules();
    vi.doMock("../config/env.js", () => ({
      env: { LINKEDIN_ORG_CLIENT_ID: null },
    }));
    const { buildAuthUrl } = await import(
      "../domains/studio/oauth/linkedinOrg.oauth.js"
    );
    expect(() => buildAuthUrl({ state: "abc" })).toThrow(
      /Organization Page.*not configured/i
    );
    vi.doUnmock("../config/env.js");
    vi.resetModules();
  });
});

describe("linkedinOrg.oauth — exchangeCode", () => {
  it("maps unauthorized_scope_error to a user-facing approval message", async () => {
    vi.resetModules();
    vi.doMock("../config/env.js", () => ({ env: { ...ENV } }));
    const { exchangeCode } = await import(
      "../domains/studio/oauth/linkedinOrg.oauth.js"
    );
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: "unauthorized_scope_error",
        error_description: "scope not authorized",
      }),
    });
    await expect(exchangeCode({ code: "x" })).rejects.toThrow(
      /Community Management API approval/i
    );
    vi.doUnmock("../config/env.js");
    vi.resetModules();
  });
});

describe("linkedinOrgPages.service.listManageableOrganizations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../config/env.js", () => ({ env: { ...ENV } }));
  });

  it("returns parsed orgs from the organizationalEntityAcls response", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "LINKEDIN_ORGANIZATION_PAGE",
      accessToken: "stored-token",
      status: "CONNECTED",
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        elements: [
          {
            organization: "urn:li:organization:111",
            "organization~": {
              id: 111,
              localizedName: "Acme Co",
              vanityName: "acme",
              logoV2: {
                "original~": {
                  elements: [{ identifiers: [{ identifier: "https://logo/a.png" }] }],
                },
              },
            },
          },
          {
            organization: "urn:li:organization:222",
            "organization~": {
              id: 222,
              localizedName: "Beta LLC",
            },
          },
        ],
      }),
    });
    const { listManageableOrganizations } = await import(
      "../domains/studio/linkedinOrgPages.service.js"
    );
    const orgs = await listManageableOrganizations({ connectionId: "c1" });
    expect(orgs).toHaveLength(2);
    expect(orgs[0]).toEqual({
      id: "111",
      urn: "urn:li:organization:111",
      name: "Acme Co",
      vanityName: "acme",
      logoUrl: "https://logo/a.png",
    });
    expect(orgs[1].name).toBe("Beta LLC");
    expect(orgs[1].logoUrl).toBeNull();
  });

  it("returns empty array when LinkedIn returns no elements", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "LINKEDIN_ORGANIZATION_PAGE",
      accessToken: "stored",
      status: "CONNECTED",
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ elements: [] }),
    });
    const { listManageableOrganizations } = await import(
      "../domains/studio/linkedinOrgPages.service.js"
    );
    const orgs = await listManageableOrganizations({ connectionId: "c1" });
    expect(orgs).toEqual([]);
  });

  it("typed PROVIDER_PERMISSION_DENIED on 403 (Community Management API not approved)", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "LINKEDIN_ORGANIZATION_PAGE",
      accessToken: "stored",
      status: "CONNECTED",
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const { listManageableOrganizations } = await import(
      "../domains/studio/linkedinOrgPages.service.js"
    );
    await expect(
      listManageableOrganizations({ connectionId: "c1" })
    ).rejects.toMatchObject({
      code: "PROVIDER_PERMISSION_DENIED",
      status: 403,
    });
  });

  it("rejects WRONG_CHANNEL if the connection isn't an org connection", async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValueOnce({
      id: "c1",
      channel: "LINKEDIN",
      accessToken: "stored",
      status: "CONNECTED",
    });
    const { listManageableOrganizations } = await import(
      "../domains/studio/linkedinOrgPages.service.js"
    );
    await expect(
      listManageableOrganizations({ connectionId: "c1" })
    ).rejects.toMatchObject({ code: "WRONG_CHANNEL" });
  });
});

describe("linkedinOrg.adapter — publishPost", () => {
  it("refuses to publish when the connection has no org URN selected", async () => {
    const { linkedinOrgAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/linkedinOrg.adapter.js"
    );
    const draft = { body: "hello", hashtags: [], mediaUrl: null };
    const connection = { accessToken: "tok", externalAccountId: null };
    await expect(
      linkedinOrgAdapter.publishPost({ draft, connection })
    ).rejects.toMatchObject({ code: "ORG_PAGE_NOT_SELECTED" });
  });

  it("posts with the stored organization URN as author", async () => {
    const { linkedinOrgAdapter } = await import(
      "../domains/studio/publishing/channelAdapters/linkedinOrg.adapter.js"
    );
    const draft = { body: "hello", hashtags: ["#growth"], mediaUrl: null };
    const connection = {
      accessToken: "tok",
      externalAccountId: "urn:li:organization:111",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Map([["x-restli-id", "urn:li:share:abc"]]),
      json: async () => ({}),
    });
    // Map needs a .get method for headers in fetch responses; vi's
    // ResponseLike already supports it via Map. Patch just in case:
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      headers: { get: (k) => (k === "x-restli-id" ? "urn:li:share:abc" : null) },
      json: async () => ({}),
    });
    global.fetch = fetchMock;

    const r = await linkedinOrgAdapter.publishPost({ draft, connection });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.linkedin.com/rest/posts");
    const body = JSON.parse(init.body);
    expect(body.author).toBe("urn:li:organization:111");
    expect(body.commentary).toContain("#growth");
    expect(r).toEqual({
      externalPostId: "urn:li:share:abc",
      externalPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:abc/",
    });
  });
});
