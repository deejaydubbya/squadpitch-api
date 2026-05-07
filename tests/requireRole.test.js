// Verifies the Auth0 role-claim namespace migration:
// the new `https://squadpitch.com/roles` namespace is read first, with the
// legacy `https://mivalta.com/roles` namespace honored as a fallback.

import { describe, it, expect } from "vitest";
import { getUserRoles } from "../middleware/requireRole.js";

function reqWithClaims(claims) {
  return { auth: { payload: claims } };
}

describe("getUserRoles", () => {
  it("reads from the new squadpitch.com namespace", () => {
    const req = reqWithClaims({
      "https://squadpitch.com/roles": ["admin"],
    });
    expect(getUserRoles(req)).toEqual(["admin"]);
  });

  it("falls back to the legacy mivalta.com namespace when squadpitch.com is missing", () => {
    const req = reqWithClaims({
      "https://mivalta.com/roles": ["developer"],
    });
    expect(getUserRoles(req)).toEqual(["developer"]);
  });

  it("prefers the new namespace when both are present (migration window)", () => {
    const req = reqWithClaims({
      "https://squadpitch.com/roles": ["admin"],
      "https://mivalta.com/roles": ["developer"],
    });
    expect(getUserRoles(req)).toEqual(["admin"]);
  });

  it("returns an empty array when neither claim is present", () => {
    expect(getUserRoles(reqWithClaims({}))).toEqual([]);
  });

  it("returns an empty array when claim is not an array", () => {
    const req = reqWithClaims({ "https://squadpitch.com/roles": "admin" });
    expect(getUserRoles(req)).toEqual([]);
  });

  it("handles missing req.auth gracefully", () => {
    expect(getUserRoles({})).toEqual([]);
  });
});
