// CRM-lite — Contact PATCH endpoint.
//
// Covers the safety contracts from spinstr 04:
//   - Status, identity, and tags can be updated independently.
//   - Tenant isolation: another workspace's contact returns 404.
//   - At least one of email/phone must remain non-null.
//   - (clientId, email) and (clientId, phone) unique constraints
//     surface as 409 IDENTITY_CONFLICT.
//   - Audit diff captures before/after for every changed key.

import { describe, it, expect, vi, beforeEach } from "vitest";

let state;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return state.prisma;
  },
}));

const service = await import("../domains/inbox/inbox.service.js");

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

function buildPrismaMock() {
  const contacts = new Map([
    [
      "contact-a",
      {
        id: "contact-a",
        clientId: CLIENT_A,
        email: "alice@example.com",
        phone: "+15551111111",
        name: "Alice",
        status: "NEW",
        tags: ["form-lead"],
        enrichmentJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    [
      "contact-a2",
      {
        id: "contact-a2",
        clientId: CLIENT_A,
        email: "bob@example.com",
        phone: null,
        name: "Bob",
        status: "NEW",
        tags: [],
        enrichmentJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    [
      "contact-b",
      {
        id: "contact-b",
        clientId: CLIENT_B,
        email: "stranger@example.com",
        phone: null,
        name: "Stranger",
        status: "NEW",
        tags: [],
        enrichmentJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  ]);

  return {
    state: { contacts },
    contact: {
      findFirst: vi.fn(async ({ where }) => {
        for (const c of contacts.values()) {
          if (where.id && c.id !== where.id) continue;
          if (where.clientId && c.clientId !== where.clientId) continue;
          return c;
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }) => {
        const current = contacts.get(where.id);
        if (!current) throw new Error("Not found");
        // Enforce the @@unique([clientId, email]) /
        // @@unique([clientId, phone]) constraints so conflict tests
        // can rely on a real P2002.
        for (const other of contacts.values()) {
          if (other.id === where.id) continue;
          if (other.clientId !== current.clientId) continue;
          if (data.email != null && other.email === data.email) {
            const err = new Error("Unique constraint failed");
            err.code = "P2002";
            err.meta = { target: ["clientId", "email"] };
            throw err;
          }
          if (data.phone != null && other.phone === data.phone) {
            const err = new Error("Unique constraint failed");
            err.code = "P2002";
            err.meta = { target: ["clientId", "phone"] };
            throw err;
          }
        }
        const next = { ...current, ...data, updatedAt: new Date() };
        contacts.set(where.id, next);
        return next;
      }),
    },
  };
}

beforeEach(() => {
  state = { prisma: buildPrismaMock() };
});

// ── Status ──────────────────────────────────────────────────────────────

describe("updateContact — status", () => {
  it("updates status NEW → QUALIFIED and returns a diff", async () => {
    const result = await service.updateContact(CLIENT_A, "contact-a", {
      status: "QUALIFIED",
    });
    expect(result.contact.status).toBe("QUALIFIED");
    expect(result.diff).toEqual({ status: { from: "NEW", to: "QUALIFIED" } });
  });

  it("returns an empty diff when status is set to its current value (no-op)", async () => {
    const result = await service.updateContact(CLIENT_A, "contact-a", {
      status: "NEW",
    });
    expect(result.diff).toEqual({});
    // The audit layer keys on Object.keys(diff).length so the
    // empty object short-circuits the AuditLog write.
  });
});

// ── Identity (name / email / phone) ─────────────────────────────────────

describe("updateContact — identity", () => {
  it("updates name", async () => {
    const result = await service.updateContact(CLIENT_A, "contact-a", {
      name: "Alice Updated",
    });
    expect(result.contact.name).toBe("Alice Updated");
    expect(result.diff.name).toEqual({ from: "Alice", to: "Alice Updated" });
  });

  it("clears email to null when explicitly passed null (phone still satisfies identity rule)", async () => {
    const result = await service.updateContact(CLIENT_A, "contact-a", {
      email: null,
    });
    expect(result.contact.email).toBeNull();
    expect(result.contact.phone).toBe("+15551111111");
  });

  it("rejects clearing both email and phone (IDENTITY_REQUIRED)", async () => {
    await expect(
      service.updateContact(CLIENT_A, "contact-a", {
        email: null,
        phone: null,
      }),
    ).rejects.toMatchObject({ status: 400, code: "IDENTITY_REQUIRED" });
    // Row stays unchanged.
    expect(state.prisma.state.contacts.get("contact-a").email).toBe("alice@example.com");
  });

  it("rejects clearing the only remaining identity field", async () => {
    // contact-a2 already has no phone — clearing email leaves nothing.
    await expect(
      service.updateContact(CLIENT_A, "contact-a2", { email: null }),
    ).rejects.toMatchObject({ status: 400, code: "IDENTITY_REQUIRED" });
  });

  it("maps P2002 email collision to 409 IDENTITY_CONFLICT", async () => {
    // contact-a2 already holds bob@example.com; trying to move
    // contact-a onto it must conflict.
    const err = await service
      .updateContact(CLIENT_A, "contact-a", { email: "bob@example.com" })
      .catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("IDENTITY_CONFLICT");
    expect(err.field).toBe("email");
  });
});

// ── Tags ────────────────────────────────────────────────────────────────

describe("updateContact — tags", () => {
  it("replaces the tag set", async () => {
    const result = await service.updateContact(CLIENT_A, "contact-a", {
      tags: ["vip", "newsletter"],
    });
    expect(result.contact.tags).toEqual(["vip", "newsletter"]);
    expect(result.diff.tags).toEqual({
      from: ["form-lead"],
      to: ["vip", "newsletter"],
    });
  });

  it("clears tags when passed an empty array", async () => {
    const result = await service.updateContact(CLIENT_A, "contact-a", {
      tags: [],
    });
    expect(result.contact.tags).toEqual([]);
  });

  it("emits no tag diff when the array contents are identical", async () => {
    const result = await service.updateContact(CLIENT_A, "contact-a", {
      tags: ["form-lead"],
    });
    expect(result.diff.tags).toBeUndefined();
  });
});

// ── Tenant isolation ────────────────────────────────────────────────────

describe("updateContact — tenant isolation", () => {
  it("returns CONTACT_NOT_FOUND when caller workspace doesn't own the contact", async () => {
    await expect(
      service.updateContact(CLIENT_A, "contact-b", { status: "QUALIFIED" }),
    ).rejects.toMatchObject({ status: 404, code: "CONTACT_NOT_FOUND" });
    // The other workspace's row stays untouched.
    expect(state.prisma.state.contacts.get("contact-b").status).toBe("NEW");
  });

  it("returns CONTACT_NOT_FOUND for a fabricated contact id", async () => {
    await expect(
      service.updateContact(CLIENT_A, "nonexistent", { status: "QUALIFIED" }),
    ).rejects.toMatchObject({ status: 404, code: "CONTACT_NOT_FOUND" });
  });
});
