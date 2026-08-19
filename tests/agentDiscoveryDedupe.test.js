import { beforeEach, describe, expect, it, vi } from "vitest";

const storedProviderIds = new Set();
const storedEmails = new Set();
const prismaMock = {
  agentDiscoveryRun: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  agentOutreachProspect: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  outreachSuppression: { findFirst: vi.fn() }, outreachSendingAccount: { findMany: vi.fn() },
};
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../config/env.js", () => ({ env: { APP_URL: "https://app.squadpitch.test" } }));
vi.mock("../lib/tokenCrypto.js", () => ({ encryptToken: vi.fn(), decryptToken: vi.fn() }));
vi.mock("../domains/prospects/prospect.service.js", () => ({ createProspect: vi.fn(), startProspectPreparation: vi.fn(), digestSecret: vi.fn() }));

const service = await import("../domains/prospects/outreach.service.js");
const prospectServiceMock = await import("../domains/prospects/prospect.service.js");

function directory(ids) { return ids.map((id) => `<a href="/oh/columbus/agent/agent-${id}/aid_${id}/">Agent ${id}</a>`).join(""); }
function profile(id) { return `<script type="application/ld+json">{"@type":"Person","name":"Agent ${id}","email":"agent${id}@example.com"}</script><a href="/oh/columbus/agent/agent-${id}/aid_${id}/listings/">Listings</a>`; }
function listing(id) { return `<article><a href="/oh/columbus/home/${id}-main/pid_${id}/">${id} Main St $500,000</a></article>`; }
function directoryPage(page, ids, nextPage) {
  return `${directory(ids)}${nextPage ? `<a rel="next" href="/oh/columbus/agents/p_${nextPage}/">Next</a>` : ""}`;
}

describe("permanent outreach discovery deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks(); storedProviderIds.clear(); storedEmails.clear();
    let runNumber = 0;
    prismaMock.agentDiscoveryRun.create.mockImplementation(({ data }) => Promise.resolve({ id: `run${++runNumber}`, ...data }));
    prismaMock.agentDiscoveryRun.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prismaMock.agentDiscoveryRun.findUnique.mockResolvedValue({ status: "RUNNING" });
    prismaMock.outreachSuppression.findFirst.mockResolvedValue(null);
    prismaMock.agentOutreachProspect.findUnique.mockImplementation(({ where }) => {
      const providerId = where.provider_providerExternalId?.providerExternalId;
      const email = where.normalizedEmail;
      return Promise.resolve((providerId && storedProviderIds.has(providerId)) || (email && storedEmails.has(email)) ? { id: "existing", status: "EMAIL_SENT" } : null);
    });
    prismaMock.agentOutreachProspect.create.mockImplementation(({ data }) => { storedProviderIds.add(data.providerExternalId); if (data.normalizedEmail) storedEmails.add(data.normalizedEmail); return Promise.resolve({ id: `outreach-${data.providerExternalId}`, ...data }); });
  });

  it("traverses five directory pages sequentially exactly once with no default limit", async () => {
    for (let id = 1; id <= 5; id += 1) storedProviderIds.add(String(id));
    const fetchedPages = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const page = Number(path.match(/\/p_(\d+)\/?$/)?.[1] || 1);
      fetchedPages.push(page);
      return { ok: true, text: async () => directoryPage(page, [String(page)], page < 5 ? page + 1 : null) };
    });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { delayMs: 0 });
    expect(run).toMatchObject({ status: "COMPLETED", pagesScanned: 5, agentLinksFound: 5, duplicateCount: 5, newAgentsCount: 0 });
    expect(fetchedPages).toEqual([1, 2, 3, 4, 5]);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    fetchSpy.mockRestore();
  });

  it("honors an explicit one-page development limit without changing the unlimited default", async () => {
    storedProviderIds.add("1"); storedProviderIds.add("2");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).pathname.match(/\/p_(\d+)\/?$/)?.[1] || 1);
      return { ok: true, text: async () => directoryPage(page, [String(page)], page + 1) };
    });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { maxPages: 1, maxAgents: 3, delayMs: 0 });
    expect(run).toMatchObject({ status: "COMPLETED", pagesScanned: 1, duplicateCount: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("persists pause and stop transitions and resumes the same run cursor", async () => {
    prismaMock.agentDiscoveryRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agentDiscoveryRun.findUnique.mockResolvedValueOnce({ id: "run-control", status: "PAUSED" });
    expect(await service.pauseDiscovery("run-control")).toMatchObject({ status: "PAUSED" });
    prismaMock.agentDiscoveryRun.findUnique.mockResolvedValueOnce({ id: "run-control", status: "STOPPED" });
    expect(await service.stopDiscovery("run-control")).toMatchObject({ status: "STOPPED" });
    expect(prismaMock.agentDiscoveryRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "run-control", status: "RUNNING" }, data: { status: "PAUSED" } }));
    expect(prismaMock.agentDiscoveryRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "run-control", status: { in: ["RUNNING", "PAUSED"] } }, data: expect.objectContaining({ status: "STOPPED" }) }));

    storedProviderIds.add("2");
    const paused = { id: "run-control", sourceUrl: "https://www.coldwellbankerhomes.com/oh/columbus/agents/", sourceDomain: "www.coldwellbankerhomes.com", status: "PAUSED", pagesScanned: 1, agentLinksFound: 1, profilesFound: 0, newAgentsCount: 0, qualifiedCount: 0, rejectedCount: 0, duplicateCount: 1, suppressedCount: 0, errorCount: 0, cursor: { nextPage: "https://www.coldwellbankerhomes.com/oh/columbus/agents/p_2", visitedPages: ["https://www.coldwellbankerhomes.com/oh/columbus/agents"], visitedAgents: ["COLDWELL_BANKER_HOMES:1"], maxPages: null, maxAgents: null } };
    prismaMock.agentDiscoveryRun.findUnique.mockResolvedValueOnce(paused).mockResolvedValue({ status: "RUNNING" });
    prismaMock.agentDiscoveryRun.update.mockImplementation(({ where, data }) => Promise.resolve({ ...paused, id: where.id, ...data }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, text: async () => directory(["2"]) });
    const resumed = await service.resumeDiscovery("run-control", { delayMs: 0 });
    expect(resumed).toMatchObject({ id: "run-control", status: "COMPLETED", pagesScanned: 2, duplicateCount: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("stops cleanly when page three only links backward", async () => {
    for (let id = 1; id <= 3; id += 1) storedProviderIds.add(String(id));
    const fetchedPages = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).pathname.match(/\/p_(\d+)\/?$/)?.[1] || 1);
      fetchedPages.push(page);
      const next = page < 3 ? page + 1 : 2;
      return { ok: true, text: async () => directoryPage(page, [String(page)], next) };
    });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { delayMs: 0 });
    expect(run).toMatchObject({ status: "COMPLETED", pagesScanned: 3, duplicateCount: 3 });
    expect(fetchedPages).toEqual([1, 2, 3]);
    fetchSpy.mockRestore();
  });

  it("simulates all 200 pages without reprocessing known agents or creating duplicates", async () => {
    const idsByPage = Array.from({ length: 200 }, (_, page) => Array.from({ length: 20 }, (_, offset) => String(page * 20 + offset + 1)));
    idsByPage.flat().forEach((id) => storedProviderIds.add(id));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).pathname.match(/\/p_(\d+)\/?$/)?.[1] || 1);
      return { ok: true, text: async () => directoryPage(page, idsByPage[page - 1], page < 200 ? page + 1 : null) };
    });
    const run = await service.discoverAgents("https://www.coldwellbankerhomes.com/oh/columbus/agents/", "admin", { delayMs: 0 });
    expect(run).toMatchObject({ status: "COMPLETED", pagesScanned: 200, agentLinksFound: 4000, duplicateCount: 4000, newAgentsCount: 0 });
    expect(prismaMock.agentOutreachProspect.create).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(200);
    fetchSpy.mockRestore();
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

  it.each(["DISCOVERED", "QUALIFIED", "READY_TO_EMAIL", "EMAIL_SENT", "MANUAL_OUTREACH", "CLAIMED", "UNSUBSCRIBED", "BOUNCED", "SUPPRESSED"])("treats historical %s records as already targeted", async (status) => {
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

  it("propagates the discovered headshot into the existing prospect profile image field", async () => {
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue({ id: "outreach-1", fullName: "Jane Agent", email: "jane@example.com", brokerage: "Example Realty", profileUrl: "https://example.com/jane", headshotUrl: "https://cdn.example/jane.jpg", sourceDomain: "example.com", status: "QUALIFIED", listings: [{ listingUrl: "https://example.com/property/1" }] });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({});
    prospectServiceMock.createProspect.mockResolvedValue({ id: "workspace-1", previewToken: "preview", claimToken: "claim" });
    await service.generatePreview("outreach-1", "admin");
    expect(prospectServiceMock.createProspect).toHaveBeenCalledWith(expect.objectContaining({ profileImageUrl: "https://cdn.example/jane.jpg" }), "admin");
  });
});
