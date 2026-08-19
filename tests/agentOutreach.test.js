import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const verify = vi.fn();
const createProspect = vi.fn();
const startProspectPreparation = vi.fn();
const prismaMock = {
  agentDiscoveryRun: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  agentOutreachProspect: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  outreachSuppression: { findFirst: vi.fn(), upsert: vi.fn() },
  outreachSendingAccount: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail, verify })) } }));
vi.mock("../config/env.js", () => ({ env: { APP_URL: "https://app.squadpitch.test" } }));
vi.mock("../lib/tokenCrypto.js", () => ({ encryptToken: vi.fn((value) => `encrypted:${value}`), decryptToken: vi.fn((value) => value.replace(/^encrypted:/, "")) }));
vi.mock("../domains/prospects/prospect.service.js", () => ({ createProspect, startProspectPreparation, digestSecret: vi.fn((value) => `digest:${value}`) }));

const service = await import("../domains/prospects/outreach.service.js");

describe("agent outreach safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.agentOutreachProspect.findMany.mockResolvedValue([]);
    prismaMock.outreachSuppression.findFirst.mockResolvedValue(null);
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

  it("uses the required editable default template and all minimum links", () => {
    expect(service.outreachTemplate.subject).toBe("I made this for you, {{first_name}}");
    expect(service.outreachTemplate.body).toContain("{{preview_url}}");
    expect(service.outreachTemplate.body).toContain("{{unsubscribe_url}}");
    expect(service.outreachTemplate.body).toContain("{{sender_name}}");
  });

  it("acquires an atomic send lock before contacting SMTP", async () => {
    const row = { id: "o1", email: "test@example.com", normalizedEmail: "test@example.com", status: "READY_TO_EMAIL", emailSentAt: null, emailSubject: "Hello", emailBody: "Body", claimUrlEncrypted: "encrypted:https://app/preview/x", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: null };
    const account = { id: "a1", provider: "SMTP", enabled: true, displayName: "Sender", fromEmail: "sender@example.com", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true, smtpUsername: "user", smtpPassword: "encrypted:secret", hourlyLimit: 10, dailyLimit: 20, delaySeconds: 1 };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValue(row);
    prismaMock.outreachSendingAccount.findUnique.mockResolvedValue(account);
    prismaMock.agentOutreachProspect.count.mockResolvedValue(0);
    prismaMock.agentOutreachProspect.findFirst.mockResolvedValue(null);
    prismaMock.agentOutreachProspect.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.sendOutreachEmail("o1", "a1")).rejects.toMatchObject({ code: "OUTREACH_SEND_LOCKED" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("enforces account delay server-side", async () => {
    const row = { id: "o1", email: "test@example.com", normalizedEmail: "test@example.com", status: "READY_TO_EMAIL", emailSentAt: null, emailSubject: "Hello", emailBody: "Body", claimUrlEncrypted: "encrypted:https://app/preview/x", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: null };
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

  it("moves one fake agent from qualified through preview, email, and claimed without external delivery", async () => {
    const qualified = { id: "o1", firstName: "Test", fullName: "Test Agent", email: "test@example.com", brokerage: "Test Realty", sourceDomain: "broker.example", profileUrl: "https://broker.example/agents/test", status: "QUALIFIED", listings: [{ listingUrl: "https://broker.example/listing/123", address: "123 Test St" }] };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValueOnce(qualified);
    createProspect.mockResolvedValue({ id: "p1", previewToken: "preview-token", claimToken: "claim-token" });
    startProspectPreparation.mockResolvedValue({ run: { id: "run1" } });
    prismaMock.agentOutreachProspect.update.mockResolvedValue({ ...qualified, status: "PREVIEW_GENERATING" });
    await expect(service.generatePreview("o1", "admin")).resolves.toEqual({ id: "o1", status: "PREVIEW_GENERATING" });
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ prospectWorkspaceId: "p1", status: "PREVIEW_GENERATING", claimUrlEncrypted: expect.stringContaining("#claim=claim-token") }) }));

    const ready = { ...qualified, status: "READY_TO_EMAIL", claimUrlEncrypted: "encrypted:https://app.squadpitch.test/preview/preview-token#claim=claim-token", prospectWorkspace: { claimStatus: "CLAIMABLE" }, sendingAccount: { id: "a1", displayName: "Test Sender" }, activeListingCount: 1 };
    prismaMock.agentOutreachProspect.findUnique.mockResolvedValueOnce(ready);
    prismaMock.agentOutreachProspect.update.mockImplementationOnce(({ data }) => Promise.resolve({ ...ready, ...data, events: [], sendingAccount: ready.sendingAccount }));
    const drafted = await service.prepareEmail("o1", { sendingAccountId: "a1" });
    expect(drafted.emailSubject).toBe("I made this for you, Test");
    expect(drafted.emailBody).toContain("https://app.squadpitch.test/preview/preview-token#claim=claim-token");
    expect(drafted.emailBody).toContain("/api/public/outreach/unsubscribe?token=");

    prismaMock.agentOutreachProspect.findMany.mockResolvedValueOnce([{ id: "o1", prospectWorkspace: { claimedAt: new Date("2026-08-18T12:00:00Z") } }]);
    prismaMock.agentOutreachProspect.update.mockResolvedValueOnce({ status: "CLAIMED" });
    await service.syncClaimed("o1");
    expect(prismaMock.agentOutreachProspect.update).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "o1" }, data: expect.objectContaining({ status: "CLAIMED", claimedAt: new Date("2026-08-18T12:00:00Z") }) }));
    expect(sendMail).not.toHaveBeenCalled();
  });
});
