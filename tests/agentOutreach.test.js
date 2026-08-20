import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const verify = vi.fn();
const createProspect = vi.fn();
const startProspectPreparation = vi.fn();
const reconcileProspectPreparationRuns = vi.fn();
const queueAdd = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, verify }));
const prismaMock = {
  agentDiscoveryRun: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  agentOutreachProspect: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  outreachSuppression: { findFirst: vi.fn(), upsert: vi.fn() },
  outreachSendingAccount: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  outreachEmailTemplate: { upsert: vi.fn() },
  prospectWorkspace: { findUnique: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("../config/env.js", () => ({ env: { APP_URL: "https://app.squadpitch.test" } }));
vi.mock("../lib/tokenCrypto.js", () => ({ encryptToken: vi.fn((value) => `encrypted:${value}`), decryptToken: vi.fn((value) => value.replace(/^encrypted:/, "")) }));
vi.mock("../lib/queues.js", () => ({ getOutreachEmailQueue: vi.fn(() => ({ add: queueAdd })) }));
vi.mock("../domains/prospects/prospect.service.js", () => ({ createProspect, startProspectPreparation, reconcileProspectPreparationRuns, digestSecret: vi.fn((value) => `digest:${value}`) }));

const service = await import("../domains/prospects/outreach.service.js");

describe("agent outreach safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.agentOutreachProspect.findMany.mockResolvedValue([]);
    prismaMock.outreachSuppression.findFirst.mockResolvedValue(null);
    prismaMock.outreachEmailTemplate.upsert.mockResolvedValue({ id: "default", ...service.outreachTemplate });
    queueAdd.mockResolvedValue({ id: "job" });
  });

  it.each([
    [{ name: "Test Agent", email: "Test@Example.com" }, [{}], "QUALIFIED", "test@example.com"],
    [{ name: "No Email" }, [{}], "NO_EMAIL", null],
    [{ name: "Bad", email: "not-an-email" }, [{}], "INVALID_EMAIL", "not-an-email"],
    [{ name: "No Listings", email: "agent@example.com" }, [], "NO_ACTIVE_LISTINGS", "agent@example.com"],
  ])("qualifies public agent data deterministically", (person, listings, status, email) => {
    expect(service.qualifyDiscoveredAgent(person, listings)).toMatchObject({ status, email });
  });

  it("extracts one agent and only active-looking listing links", () => {
    const result = service.parseDiscoveryPage(`
      <script type="application/ld+json">{"@type":"Person","name":"Test Agent","email":"test@example.com","url":"/agents/test"}</script>
      <a href="/listing/123">123 Main St</a><a href="/listing/old">Sold listing</a>
    `, "https://broker.example/agents");
    expect(result.people).toHaveLength(1);
    expect(result.listings).toEqual([{ listingUrl: "https://broker.example/listing/123", address: "123 Main St", status: "ACTIVE", sourceUrl: "https://broker.example/listing/123" }]);
  });

  it("uses the approved canonical outreach template and all required links", () => {
    expect(service.outreachTemplate.subject).toBe("I created a free Squadpitch workspace for you");
    expect(service.outreachTemplate.textBody).toContain("I’m Daniel, the founder of Squadpitch");
    expect(service.outreachTemplate.textBody).toContain("ready-to-claim workspaces");
    expect(service.outreachTemplate.textBody).toContain("same email address I sent this message to");
    expect(service.outreachTemplate.textBody).toContain("{{listing_addresses}}");
    expect(service.outreachTemplate.htmlBody).toContain("{{listing_addresses}}");
    expect(service.outreachTemplate.textBody).toContain("14-day trial of Squadpitch Pro with no credit card required");
    expect(service.outreachTemplate.textBody).toContain("https://real-estate.squadpitch.com");
    expect(service.outreachTemplate.textBody).toContain("https://www.linkedin.com/company/115992427");
    expect(service.outreachTemplate.textBody).toContain("I’d really appreciate any feedback");
    expect(service.outreachTemplate.textBody).toContain("Daniel Wardlow\nFounder, Squadpitch");
    expect(service.outreachTemplate.textBody).toContain("{{preview_url}}");
    expect(service.outreachTemplate.textBody).toContain("{{unsubscribe_url}}");
    expect(service.outreachTemplate.htmlBody).toContain("View &amp; Claim Your Workspace");
    expect(service.outreachTemplate.htmlBody).toContain('href="{{preview_url}}"');
  });

  it("formats all listing addresses and falls back to readable listing URL slugs", () => {
    expect(service.listingAddresses([
      { address: "123 Main St, Columbus, OH" },
      { listingUrl: "https://www.coldwellbankerhomes.com/oh/dublin/5341-aryshire-dr/pid_72517648" },
      { listingUrl: "https://www.coldwellbankerhomes.com/oh/thornville/0-dahlia-dr-ne/pid_72966254" },
    ])).toEqual(["123 Main St, Columbus, OH", "5341 Aryshire Dr", "0 Dahlia Dr NE"]);
  });

  it("counts repeat opens without exposing the prospect in the token", async () => {
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue({ id: "p1", emailFirstOpenedAt: null });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({});
    await expect(service.trackOpen("opaque-token", "Mozilla/5.0")).resolves.toBe(true);
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ emailOpenCount: { increment: 1 } }) }));
  });

  it("attributes a preview only when both opaque tokens resolve to the same workspace", async () => {
    prismaMock.prospectWorkspace.findUnique.mockResolvedValue({ id: "w1" });
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue({ id: "p1", prospectWorkspaceId: "w1", previewFirstViewedAt: null });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({});
    await expect(service.trackPreviewView("click-token", "preview-token", "Mozilla/5.0")).resolves.toBe(true);
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ previewViewCount: { increment: 1 } }) }));
  });

  it("never generates a preview for a zero-listing rejection", async () => {
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue({ id: "zero", status: "NO_ACTIVE_LISTINGS", email: "agent@example.com", activeListingCount: 0, listings: [] });
    await expect(service.generatePreview("zero", "admin")).rejects.toMatchObject({ code: "INVALID_OUTREACH_STATE" });
    expect(createProspect).not.toHaveBeenCalled();
    expect(startProspectPreparation).not.toHaveBeenCalled();
  });

  it.each([
    [["A", "B", "C", "D", "E"], ["A", "B", "C"]],
    [["A", "B", "C"], ["A", "B", "C"]],
    [["A", "B"], ["A", "B", "A"]],
    [["A"], ["A", "A", "A"]],
    [[], []],
  ])("selects three deterministic preview listings from %j", (ids, expected) => {
    const listings = ids.map((listingId) => ({ listingId, listingUrl: `https://broker.example/listing/${listingId}` }));
    expect(service.selectListingsForPreview(listings).map((listing) => listing.listingId)).toEqual(expected);
  });

  it("deduplicates stored listings before preview selection", () => {
    const listings = [
      { listingId: "A", listingUrl: "https://broker.example/listing/a" },
      { listingId: "A", listingUrl: "https://broker.example/listing/a?duplicate=1" },
      { listingId: "B", listingUrl: "https://broker.example/listing/b" },
      { listingId: "C", listingUrl: "https://broker.example/listing/c" },
    ];
    expect(service.selectListingsForPreview(listings).map((listing) => listing.listingId)).toEqual(["A", "B", "C"]);
  });

  it("hands three distinct stored properties to preview preparation", async () => {
    const listings = ["A", "B", "C", "D"].map((listingId) => ({ listingId, listingUrl: `https://broker.example/listing/${listingId}` }));
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue({ id: "multi", fullName: "Multi Listing", email: "multi@example.com", status: "QUALIFIED", sourceDomain: "broker.example", listings });
    createProspect.mockResolvedValue({ id: "workspace", previewToken: "preview", claimToken: "claim" });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({});
    startProspectPreparation.mockResolvedValue({ run: { id: "run" } });

    await service.generatePreview("multi", "admin");

    const selected = startProspectPreparation.mock.calls[0][1].selectedListings;
    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((listing) => listing.listingId))).toEqual(new Set(["A", "B", "C"]));
  });

  it("regenerates a ready preview in its existing claimable workspace", async () => {
    const listing = { listingId: "A", listingUrl: "https://broker.example/listing/A" };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue({ id: "ready", prospectWorkspaceId: "workspace", fullName: "Ready Agent", email: "ready@example.com", status: "READY_TO_EMAIL", sourceDomain: "broker.example", listings: [listing] });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({});
    startProspectPreparation.mockResolvedValue({ run: { id: "run" } });

    await expect(service.generatePreview("ready", "admin")).resolves.toEqual({ id: "ready", status: "PREVIEW_PENDING" });

    expect(createProspect).not.toHaveBeenCalled();
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ready" }, data: expect.objectContaining({ status: "PREVIEW_PENDING", events: { create: { type: "preview_requeued" } } }) }));
    expect(startProspectPreparation).toHaveBeenCalledWith("workspace", expect.objectContaining({ selectedChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"] }), "admin");
  });

  it("acquires an atomic send lock before contacting SMTP", async () => {
    const row = { id: "o1", email: "test@example.com", normalizedEmail: "test@example.com", status: "READY_TO_EMAIL", emailSentAt: null, emailSubject: "Hello", emailBody: "Body", emailHtmlBody: "<p>Body</p>", claimUrlEncrypted: "encrypted:https://app/preview/x", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: null };
    const account = { id: "a1", provider: "SMTP", enabled: true, displayName: "Sender", fromEmail: "sender@example.com", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true, smtpUsername: "user", smtpPassword: "encrypted:secret", hourlyLimit: 10, dailyLimit: 20, delaySeconds: 1 };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue(row);
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue(account);
    prismaMock.agentOutreachProspect.count.mockResolvedValue(0);
    prismaMock.agentOutreachProspect.findFirst.mockResolvedValue(null);
    prismaMock.agentOutreachProspect.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.sendOutreachEmail("o1", "a1")).rejects.toMatchObject({ code: "OUTREACH_SEND_LOCKED" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("queues each eligible email immediately instead of rejecting the configured send delay", async () => {
    const row = { id: "o1", email: "test@example.com", normalizedEmail: "test@example.com", status: "READY_TO_EMAIL", emailSentAt: null, emailSubject: "Hello", emailBody: "Body", emailHtmlBody: "<p>Body</p>", claimUrlEncrypted: "encrypted:https://app/preview/x", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: null };
    const account = { id: "a1", enabled: true, delaySeconds: 60 };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue(row);
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue(account);
    prismaMock.agentOutreachProspect.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.queueOutreachEmail("o1", "a1")).resolves.toEqual({ id: "o1", status: "EMAIL_QUEUED" });

    expect(prismaMock.agentOutreachProspect.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "EMAIL_QUEUED", sendingAccountId: "a1" }) }));
    expect(queueAdd).toHaveBeenCalledWith("send", { prospectId: "o1", sendingAccountId: "a1" }, expect.objectContaining({ jobId: expect.stringContaining("outreach-o1-") }));
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("enforces account delay server-side", async () => {
    const row = { id: "o1", email: "test@example.com", normalizedEmail: "test@example.com", status: "READY_TO_EMAIL", emailSentAt: null, emailSubject: "Hello", emailBody: "Body", emailHtmlBody: "<p>Body</p>", claimUrlEncrypted: "encrypted:https://app/preview/x", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: null };
    const account = { id: "a1", enabled: true, hourlyLimit: 10, dailyLimit: 20, delaySeconds: 60 };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue(row);
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue(account);
    prismaMock.agentOutreachProspect.count.mockResolvedValue(0);
    prismaMock.agentOutreachProspect.findFirst.mockResolvedValue({ emailSentAt: new Date() });
    await expect(service.sendOutreachEmail("o1", "a1")).rejects.toMatchObject({ code: "OUTREACH_SEND_DELAY" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("suppresses unsubscribe recipients and records the event", async () => {
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue({ id: "o1", normalizedEmail: "test@example.com" });
    prismaMock.outreachSuppression.upsert.mockResolvedValue({});
    prismaMock.agentOutreachProspect.update.mockResolvedValue({});
    prismaMock.$transaction.mockImplementation((operations) => Promise.all(operations));
    await expect(service.unsubscribe("valid-token")).resolves.toBe(true);
    expect(prismaMock.outreachSuppression.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ reason: "UNSUBSCRIBED" }) }));
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "UNSUBSCRIBED" }) }));
  });

  it("never returns an SMTP password after account creation", async () => {
    const tx = { outreachSendingAccount: { updateMany: vi.fn(), create: vi.fn().mockResolvedValue({ id: "a1", smtpPassword: "encrypted:secret", fromEmail: "sender@example.com" }) } };
    prismaMock.$transaction.mockImplementation((callback) => callback(tx));
    const result = await service.saveSendingAccount({ provider: "SMTP", displayName: "Sender", fromEmail: "sender@example.com", smtpHost: "smtp.example.com", smtpPort: 465, smtpUsername: "user", smtpPassword: "secret", smtpSecure: true, enabled: true, isDefault: true, hourlyLimit: 10, dailyLimit: 20, delaySeconds: 5 }, "admin");
    expect(result.smtpPassword).toBeUndefined();
    expect(tx.outreachSendingAccount.create.mock.calls[0][0].data.smtpPassword).toBe("encrypted:secret");
  });

  it("reports rejected SMTP credentials as an actionable configuration error", async () => {
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue({ id: "a1", provider: "SMTP", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true, smtpUsername: "user", smtpPassword: "encrypted:bad-password" });
    verify.mockRejectedValueOnce(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }));
    await expect(service.testSendingAccount("a1")).rejects.toMatchObject({ status: 422, code: "SMTP_AUTH_FAILED", message: expect.stringContaining("authentication failed") });
  });

  it("reports unreachable SMTP settings without exposing transport details", async () => {
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue({ id: "a1", provider: "SMTP", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true, smtpUsername: "user", smtpPassword: "encrypted:secret" });
    verify.mockRejectedValueOnce(Object.assign(new Error("connect ETIMEDOUT 192.0.2.1"), { code: "ETIMEDOUT" }));
    await expect(service.testSendingAccount("a1")).rejects.toMatchObject({ status: 422, code: "SMTP_TIMEOUT", message: expect.not.stringContaining("192.0.2.1") });
  });

  it.each([
    [{ smtpEncryption: "STARTTLS", smtpPort: 587 }, { secure: false, requireTLS: true }],
    [{ smtpEncryption: "SSL_TLS", smtpPort: 465 }, { secure: true }],
    [{ smtpEncryption: "NONE", smtpPort: 25 }, { secure: false, ignoreTLS: true }],
  ])("maps explicit SMTP encryption safely", (configuration, expected) => {
    expect(service.smtpTransportOptions({ smtpHost: "smtp.example.com", smtpUsername: "user", smtpPassword: "encrypted:secret", smtpSecure: false, ...configuration })).toMatchObject(expected);
  });

  it("classifies Microsoft SMTP AUTH policy rejection separately", async () => {
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue({ id: "a1", provider: "SMTP", smtpHost: "smtp.office365.com", smtpPort: 587, smtpEncryption: "STARTTLS", smtpUsername: "user@example.com", smtpPassword: "encrypted:secret" });
    verify.mockRejectedValueOnce(Object.assign(new Error("Authentication unsuccessful"), { code: "EAUTH", responseCode: 535, response: "535 5.7.139 SmtpClientAuthentication is disabled for the Mailbox" }));
    await expect(service.testSendingAccount("a1")).rejects.toMatchObject({ status: 422, code: "SMTP_AUTH_DISABLED" });
  });

  it("classifies TLS negotiation failures without disabling certificate checks", async () => {
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue({ id: "a1", provider: "SMTP", smtpHost: "smtp.example.com", smtpPort: 587, smtpEncryption: "STARTTLS", smtpUsername: "user", smtpPassword: "encrypted:secret" });
    verify.mockRejectedValueOnce(Object.assign(new Error("certificate verify failed"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }));
    await expect(service.testSendingAccount("a1")).rejects.toMatchObject({ status: 422, code: "SMTP_TLS_ERROR", message: expect.stringContaining("TLS negotiation failed") });
    expect(createTransport).toHaveBeenLastCalledWith(expect.not.objectContaining({ tls: expect.objectContaining({ rejectUnauthorized: false }) }));
  });

  it("returns safe successful SMTP phase diagnostics", async () => {
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue({ id: "a1", provider: "SMTP", smtpHost: "smtp.office365.com", smtpPort: 587, smtpEncryption: "STARTTLS", smtpUsername: "user@example.com", smtpPassword: "encrypted:secret" });
    verify.mockResolvedValueOnce(true);
    await expect(service.testSendingAccount("a1")).resolves.toEqual({ ok: true, diagnostic: { serverReached: true, tlsEstablished: true, authentication: "SUCCEEDED", code: "SMTP_VERIFIED" } });
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
  });

  it("moves one fake agent from qualified through preview, email, and claimed without external delivery", async () => {
    const qualified = { id: "o1", firstName: "Test", fullName: "Test Agent", email: "test@example.com", brokerage: "Test Realty", sourceDomain: "broker.example", profileUrl: "https://broker.example/agents/test", status: "QUALIFIED", listings: [{ listingUrl: "https://broker.example/listing/123", address: "123 Test St" }] };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValueOnce(qualified);
    createProspect.mockResolvedValue({ id: "p1", previewToken: "preview-token", claimToken: "claim-token" });
    startProspectPreparation.mockResolvedValue({ run: { id: "run1" } });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({ ...qualified, status: "PREVIEW_PENDING" });
    await expect(service.generatePreview("o1", "admin")).resolves.toEqual({ id: "o1", status: "PREVIEW_PENDING" });
    expect(createProspect).toHaveBeenCalledWith(expect.objectContaining({ selectedChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"] }), "admin");
    expect(startProspectPreparation).toHaveBeenCalledWith("p1", expect.objectContaining({ selectedListings: [qualified.listings[0], qualified.listings[0], qualified.listings[0]] }), "admin");
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ prospectWorkspaceId: "p1", status: "PREVIEW_PENDING", claimUrlEncrypted: expect.stringContaining("#claim=claim-token") }) }));

    const ready = { ...qualified, status: "READY_TO_EMAIL", claimUrlEncrypted: "encrypted:https://app.squadpitch.test/preview/preview-token#claim=claim-token", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: { id: "a1", displayName: "Test Sender" }, activeListingCount: 1 };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValueOnce(ready);
    prismaMock.agentOutreachProspect.update.mockImplementationOnce(({ data }) => Promise.resolve({ ...ready, ...data, events: [], sendingAccount: ready.sendingAccount }));
    const drafted = await service.prepareEmail("o1", { sendingAccountId: "a1" });
    expect(drafted.emailSubject).toBe("I created a free Squadpitch workspace for you");
    expect(drafted.emailBody).toContain("Hi Test,");
    expect(drafted.emailBody).toContain("https://app.squadpitch.test/api/public/outreach/track/click/");
    expect(drafted.emailBody).toContain("/api/public/outreach/unsubscribe?token=");
    expect(drafted.emailBody.match(/\/api\/public\/outreach\/track\/click\//g)).toHaveLength(1);
    expect(drafted.emailBody).toContain("Important: when you create your Squadpitch account");
    expect(drafted.emailBody).toContain("14-day trial of Squadpitch Pro with no credit card required");
    expect(drafted.emailBody).toContain("Daniel Wardlow\nFounder, Squadpitch");
    expect(drafted.emailBody).not.toMatch(/{{\s*(first_name|preview_url|unsubscribe_url)\s*}}/);
    expect(drafted.emailHtmlBody).toContain("Hi Test");
    expect(drafted.emailHtmlBody).toContain('href="https://app.squadpitch.test/api/public/outreach/track/click/');
    expect(drafted.emailHtmlBody).toContain('/api/public/outreach/track/open/');
    expect(drafted.emailHtmlBody).toContain("View &amp; Claim Your Workspace");
    expect(drafted.emailHtmlBody).toContain("/api/public/outreach/unsubscribe?token=");
    expect(drafted.emailHtmlBody).not.toMatch(/{{\s*(first_name|preview_url|unsubscribe_url)\s*}}/);

    prismaMock.agentOutreachProspect.findMany.mockResolvedValueOnce([{ id: "o1", prospectWorkspace: { claimedAt: new Date("2026-08-18T12:00:00Z") } }]);
    prismaMock.agentOutreachProspect.update.mockResolvedValueOnce({ status: "CLAIMED" });
    await service.syncClaimed("o1");
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "o1" }, data: expect.objectContaining({ status: "CLAIMED", claimedAt: new Date("2026-08-18T12:00:00Z") }) }));
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("escapes dynamic HTML values and sends text plus HTML multipart", async () => {
    const rendered = service.renderMultipartTemplate(service.outreachTemplate, { first_name: '<img src=x onerror=alert(1)>', preview_url: "https://app.squadpitch.test/preview/x#claim=y", unsubscribe_url: "https://app.squadpitch.test/unsubscribe?t=z" });
    expect(rendered.htmlBody).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(rendered.htmlBody).not.toContain("<img");
    expect(rendered.textBody).toContain("https://app.squadpitch.test/preview/x#claim=y");

    const row = { id: "mail", email: "agent@example.com", normalizedEmail: "agent@example.com", status: "READY_TO_EMAIL", emailSentAt: null, emailSubject: rendered.subject, emailBody: rendered.textBody, emailHtmlBody: rendered.htmlBody, claimUrlEncrypted: "encrypted:https://app/preview/x", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: null };
    const account = { id: "smtp", provider: "SMTP", enabled: true, displayName: "Daniel", fromEmail: "daniel@example.com", smtpHost: "smtp.example.com", smtpPort: 587, smtpEncryption: "STARTTLS", smtpUsername: "user", smtpPassword: "encrypted:secret", hourlyLimit: 10, dailyLimit: 20, delaySeconds: 1 };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue(row);
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue(account);
    prismaMock.agentOutreachProspect.count.mockResolvedValue(0);
    prismaMock.agentOutreachProspect.findFirst.mockResolvedValue(null);
    prismaMock.agentOutreachProspect.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({ ...row, status: "EMAIL_SENT", emailSentAt: new Date(), events: [] });
    sendMail.mockResolvedValue({ messageId: "message-1" });

    await service.sendOutreachEmail("mail", "smtp");
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: rendered.textBody, html: rendered.htmlBody }));
  });
});
