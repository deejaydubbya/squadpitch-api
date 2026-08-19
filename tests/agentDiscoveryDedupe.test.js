import { beforeEach, describe, expect, it, vi } from "vitest";

const storedProviderIds = new Set();
const storedEmails = new Set();
const prismaMock = {
  agentDiscoveryRun: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  agentOutreachProspect: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  outreachSuppression: { findFirst: vi.fn() }, outreachSendingAccount: { findMany: vi.fn() },
};
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../config/env.js", () => ({ env: { APP_URL: "https://app.squadpitch.test" } }));
vi.mock("../lib/tokenCrypto.js", () => ({ encryptToken: vi.fn(), decryptToken: vi.fn() }));
vi.mock("../domains/prospects/prospect.service.js", () => ({ createProspect: vi.fn(), startProspectPreparation: vi.fn(), digestSecret: vi.fn() }));

const service = await import("../domains/prospects/outreach.service.js");

function directory(ids) { return ids.map((id) => `<a href="/oh/columbus/agent/agent-${id}/aid_${id}/">Agent ${id}</a>`).join(""); }
function profile(id) { return `<script type="application/ld+json">{"@type":"Person","name":"Agent ${id}","email":"agent${id}@example.com"}</script><a href="/oh/columbus/agent/agent-${id}/aid_${id}/listings/">Listings</a>`; }
function listing(id) { return `<article><a href="/oh/columbus/home/${id}-main/pid_${id}/">${id} Main St $500,000</a></article>`; }

describe("permanent outreach discovery deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks(); storedProviderIds.clear(); storedEmails.clear();
    let runNumber = 0;
    prismaMock.agentDiscoveryRun.create.mockImplementation(({ data }) => Promise.resolve({ id: `run${++runNumber}`, ...data }));
    prismaMock.agentDiscoveryRun.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prismaMock.outreachSuppression.findFirst.mockResolvedValue(null);
    prismaMock.agentOutreachProspect.findUnique.mockImplementation(({ where }) => {
      const providerId = where.provider_providerExternalId?.providerExternalId;
      const email = where.normalizedEmail;
      return Promise.resolve((providerId && storedProviderIds.has(providerId)) || (email && storedEmails.has(email)) ? { id: "existing", status: "EMAIL_SENT" } : null);
    });
    prismaMock.agentOutreachProspect.create.mockImplementation(({ data }) => { storedProviderIds.add(data.providerExternalId); if (data.normalizedEmail) storedEmails.add(data.normalizedEmail); return Promise.resolve({ id: `outreach-${data.providerExternalId}`, ...data }); });
  });

  it("creates A/B/C once, then early-skips them and only creates D/E on the next crawl", async () => {
    let activeIds = ["101", "102", "103"];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = /\/agents\/?$/.test(new URL(url).pathname) ? directory(activeIds) : /\/listings\/?$/.test(new URL(url).pathname) ? listing(url.match(/aid_(\d+)/)?.[1]) : profile(url.match(/aid_(\d+)/)?.[1]);
      return { ok: true, text: async () => body };
    });
    const first = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 10, delayMs: 0 });
    expect(first).toMatchObject({ newAgentsCount: 3, qualifiedCount: 3, duplicateCount: 0 });
    expect(prismaMock.agentOutreachProspect.create).toHaveBeenCalledTimes(3);

    activeIds = ["101", "102", "103", "104", "105"];
    const callsBeforeSecondRun = fetchSpy.mock.calls.length;
    const second = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 10, delayMs: 0 });
    expect(second).toMatchObject({ newAgentsCount: 2, qualifiedCount: 2, duplicateCount: 3 });
    expect(prismaMock.agentOutreachProspect.create).toHaveBeenCalledTimes(5);
    const secondUrls = fetchSpy.mock.calls.slice(callsBeforeSecondRun).map(([url]) => String(url));
    expect(secondUrls.some((url) => /aid_(101|102|103)/.test(url))).toBe(false);
    expect(storedProviderIds).toEqual(new Set(["101", "102", "103", "104", "105"]));
    fetchSpy.mockRestore();
  });

  it.each(["DISCOVERED", "QUALIFIED", "READY_TO_EMAIL", "EMAIL_SENT", "CLAIMED", "UNSUBSCRIBED", "BOUNCED", "SUPPRESSED"])("treats historical %s records as already targeted", async (status) => {
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValueOnce({ id: "existing", status });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({ ok: true, text: async () => directory(["101"]) });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 3, delayMs: 0 });
    expect(run.duplicateCount).toBe(1);
    expect(prismaMock.agentOutreachProspect.create).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("relies on unique constraints for a final concurrent insert race", async () => {
    prismaMock.agentOutreachProspect.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { const url = String(input); return { ok: true, text: async () => /\/agents\/?$/.test(new URL(url).pathname) ? directory(["101"]) : /\/listings\/?$/.test(new URL(url).pathname) ? listing("101") : profile("101") }; });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 3, delayMs: 0 });
    expect(run).toMatchObject({ newAgentsCount: 0, duplicateCount: 1, errorCount: 0 });
    vi.restoreAllMocks();
  });

  it("performs the second dedupe after email and skips listings when the profile URL changed", async () => {
    storedEmails.add("same@example.com");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { const url = String(input); return { ok: true, text: async () => /\/agents\/?$/.test(new URL(url).pathname) ? directory(["999"]) : `<script type="application/ld+json">{"@type":"Person","name":"Changed Agent","email":"same@example.com"}</script><a href="/oh/columbus/agent/changed/aid_999/listings/">Listings</a>` }; });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 3, delayMs: 0 });
    expect(run).toMatchObject({ duplicateCount: 1, newAgentsCount: 0 });
    expect(fetchSpy.mock.calls.some(([url]) => /\/listings\/?$/.test(new URL(String(url)).pathname))).toBe(false);
    fetchSpy.mockRestore();
  });

  it("limits new agents rather than letting already-targeted identities consume the development cap", async () => {
    storedProviderIds.add("101"); storedProviderIds.add("102");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { const url = String(input); const id = url.match(/aid_(\d+)/)?.[1]; return { ok: true, text: async () => /\/agents\/?$/.test(new URL(url).pathname) ? directory(["101","102","103","104","105"]) : /\/listings\/?$/.test(new URL(url).pathname) ? listing(id) : profile(id) }; });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 3, delayMs: 0 });
    expect(run).toMatchObject({ duplicateCount: 2, newAgentsCount: 3, qualifiedCount: 3 });
    expect(storedProviderIds).toEqual(new Set(["101","102","103","104","105"]));
    vi.restoreAllMocks();
  });

  it("skips by normalized profile identity before fetching a profile", async () => {
    prismaMock.agentOutreachProspect.findUnique.mockImplementation(({ where }) => Promise.resolve(where.stableIdentity ? { id: "existing", status: "DISCOVERED" } : null));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, text: async () => directory(["101"]) });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 3, delayMs: 0 });
    expect(run.duplicateCount).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
