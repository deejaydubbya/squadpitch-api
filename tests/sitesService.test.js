// Unit tests for the SquadSites pure helpers — no Prisma calls
// here; route smoke for the resolve/submit handlers lives in the
// existing routeImports.test.js boot check.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractClientSlugFromHost,
  extractPageSlugFromPath,
} from "../domains/sites/sites.service.js";
import {
  hashIp,
  honeypotTripped,
  validateFormFields,
} from "../domains/sites/security.js";

describe("extractClientSlugFromHost", () => {
  it("returns the subdomain for a valid host", () => {
    expect(extractClientSlugFromHost("smithrealty.squadpitchsites.com")).toBe(
      "smithrealty",
    );
    expect(extractClientSlugFromHost("jane-agent.squadpitchsites.com")).toBe(
      "jane-agent",
    );
  });

  it("strips port when present", () => {
    expect(extractClientSlugFromHost("smithrealty.squadpitchsites.com:443")).toBe(
      "smithrealty",
    );
  });

  it("returns null for the apex domain", () => {
    expect(extractClientSlugFromHost("squadpitchsites.com")).toBeNull();
  });

  it("returns null for non-matching domains", () => {
    expect(extractClientSlugFromHost("evil.com")).toBeNull();
    expect(extractClientSlugFromHost("foo.example.com")).toBeNull();
  });

  it("returns null for nested subdomains", () => {
    expect(extractClientSlugFromHost("a.b.squadpitchsites.com")).toBeNull();
  });

  it("returns null for empty / weird input", () => {
    expect(extractClientSlugFromHost("")).toBeNull();
    expect(extractClientSlugFromHost(null)).toBeNull();
    expect(extractClientSlugFromHost("not a host")).toBeNull();
  });
});

describe("extractPageSlugFromPath", () => {
  it("returns the slug for a single-segment path", () => {
    expect(extractPageSlugFromPath("/spring-open-house")).toBe("spring-open-house");
  });

  it("strips trailing nothing — accepts no trailing slash", () => {
    expect(extractPageSlugFromPath("/just-listed")).toBe("just-listed");
  });

  it("returns null for the apex path", () => {
    expect(extractPageSlugFromPath("/")).toBeNull();
    expect(extractPageSlugFromPath("")).toBeNull();
  });

  it("returns null for paths with multiple segments", () => {
    expect(extractPageSlugFromPath("/foo/bar")).toBeNull();
  });

  it("returns null for malformed slugs", () => {
    expect(extractPageSlugFromPath("/FOO")).toBeNull();         // uppercase
    expect(extractPageSlugFromPath("/!@#")).toBeNull();         // punctuation
    expect(extractPageSlugFromPath("/-bad")).toBeNull();        // leading hyphen
  });

  it("accepts hyphenated and digit-containing slugs", () => {
    expect(extractPageSlugFromPath("/508-king-george-court")).toBe(
      "508-king-george-court",
    );
    expect(extractPageSlugFromPath("/q1-2026-recap")).toBe("q1-2026-recap");
  });
});

describe("hashIp", () => {
  const originalSalt = process.env.RUNTIME_IP_SALT;

  beforeEach(() => {
    process.env.RUNTIME_IP_SALT = "test-salt-1234567890";
  });
  afterEach(() => {
    if (originalSalt === undefined) delete process.env.RUNTIME_IP_SALT;
    else process.env.RUNTIME_IP_SALT = originalSalt;
  });

  it("returns null when IP is missing", () => {
    expect(hashIp(null)).toBeNull();
    expect(hashIp("")).toBeNull();
    expect(hashIp(undefined)).toBeNull();
  });

  it("returns null when salt is unset", () => {
    delete process.env.RUNTIME_IP_SALT;
    expect(hashIp("1.2.3.4")).toBeNull();
  });

  it("returns a stable 64-char hex digest for the same IP", () => {
    const h1 = hashIp("1.2.3.4");
    const h2 = hashIp("1.2.3.4");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different digests for different IPs", () => {
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("5.6.7.8"));
  });

  it("changes when the salt changes", () => {
    const a = hashIp("1.2.3.4");
    process.env.RUNTIME_IP_SALT = "different-salt-9876543210";
    const b = hashIp("1.2.3.4");
    expect(a).not.toBe(b);
  });
});

describe("honeypotTripped", () => {
  it("returns false when no honeypot value", () => {
    expect(honeypotTripped({})).toBe(false);
    expect(honeypotTripped({ name: "Alice" })).toBe(false);
  });

  it("returns false for empty-string honeypot (browser default)", () => {
    expect(honeypotTripped({ sp_hp: "" })).toBe(false);
  });

  it("returns true when honeypot has any value (bot)", () => {
    expect(honeypotTripped({ sp_hp: "bot-was-here" })).toBe(true);
  });

  it("returns false for non-object input", () => {
    expect(honeypotTripped(null)).toBe(false);
    expect(honeypotTripped(undefined)).toBe(false);
    expect(honeypotTripped("string")).toBe(false);
  });
});

describe("validateFormFields", () => {
  const basicForm = [
    { key: "name", type: "text", required: true },
    { key: "email", type: "email", required: true },
    { key: "message", type: "textarea", required: false },
  ];

  it("returns ok=true for a valid submission", () => {
    const result = validateFormFields(basicForm, {
      name: "Alice",
      email: "alice@example.com",
      message: "Hello",
    });
    expect(result.ok).toBe(true);
    expect(result.fields).toEqual({
      name: "Alice",
      email: "alice@example.com",
      message: "Hello",
    });
  });

  it("flags missing required fields", () => {
    const result = validateFormFields(basicForm, { name: "Alice" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("email"))).toBe(true);
  });

  it("allows missing optional fields", () => {
    const result = validateFormFields(basicForm, {
      name: "Alice",
      email: "alice@example.com",
    });
    expect(result.ok).toBe(true);
    expect(result.fields).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("rejects invalid emails", () => {
    const result = validateFormFields(basicForm, {
      name: "A",
      email: "not-an-email",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("email"))).toBe(true);
  });

  it("trims text and textarea fields", () => {
    const result = validateFormFields(basicForm, {
      name: "  Alice  ",
      email: "  alice@example.com  ",
      message: "  Hi there  ",
    });
    expect(result.ok).toBe(true);
    expect(result.fields.name).toBe("Alice");
    expect(result.fields.message).toBe("Hi there");
  });

  it("drops fields not declared in the form", () => {
    const result = validateFormFields(basicForm, {
      name: "Alice",
      email: "alice@example.com",
      hacker_field: "<script>alert(1)</script>",
    });
    expect(result.ok).toBe(true);
    expect(result.fields).not.toHaveProperty("hacker_field");
  });

  it("validates select against the option list", () => {
    const def = [{ key: "interest", type: "select", required: true, options: ["buy", "sell"] }];
    expect(validateFormFields(def, { interest: "buy" }).ok).toBe(true);
    expect(validateFormFields(def, { interest: "other" }).ok).toBe(false);
  });

  it("coerces checkbox to boolean", () => {
    const def = [{ key: "subscribe", type: "checkbox", required: false }];
    expect(validateFormFields(def, { subscribe: true }).fields.subscribe).toBe(true);
    expect(validateFormFields(def, { subscribe: "yes" }).fields.subscribe).toBe(true);
  });

  it("rejects phone numbers with invalid characters", () => {
    const def = [{ key: "phone", type: "phone", required: true }];
    expect(validateFormFields(def, { phone: "+1 (555) 123-4567" }).ok).toBe(true);
    expect(validateFormFields(def, { phone: "abc-defg" }).ok).toBe(false);
  });

  it("caps long text input", () => {
    const def = [{ key: "msg", type: "textarea", required: false }];
    const huge = "x".repeat(20_000);
    const result = validateFormFields(def, { msg: huge });
    expect(result.ok).toBe(true);
    expect(result.fields.msg.length).toBeLessThanOrEqual(10_000);
  });
});
