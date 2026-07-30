import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  update: vi.fn(),
  reconnectPrisma: vi.fn(),
  isConnected: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      upsert: mocks.upsert,
      update: mocks.update,
    },
  },
  reconnectPrisma: mocks.reconnectPrisma,
  isConnected: mocks.isConnected,
}));

vi.mock("../middleware/auth.js", () => ({
  getAuth0Sub: (req) => req.auth?.payload?.sub,
}));

import { requireUser } from "../middleware/requireUser.js";

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe("requireUser account reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the existing user when a verified email has a new Auth0 subject", async () => {
    const collision = Object.assign(new Error("email collision"), {
      code: "P2002",
      meta: { target: ["email"] },
    });
    mocks.upsert.mockRejectedValueOnce(collision);
    mocks.update.mockResolvedValueOnce({
      id: "user-existing",
      email: "owner@example.test",
      auth0Sub: "auth0|new-subject",
    });
    const req = {
      auth: {
        payload: {
          sub: "auth0|new-subject",
          email: "owner@example.test",
          email_verified: true,
        },
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const res = response();
    const next = vi.fn();

    await requireUser(req, res, next);

    expect(mocks.update).toHaveBeenCalledWith({
      where: { email: "owner@example.test" },
      data: { auth0Sub: "auth0|new-subject" },
    });
    expect(req.user.id).toBe("user-existing");
    expect(req.auth0Sub).toBe("auth0|new-subject");
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not link an existing account using an unverified email", async () => {
    const collision = Object.assign(new Error("email collision"), {
      code: "P2002",
      meta: { target: ["email"] },
    });
    mocks.upsert.mockRejectedValueOnce(collision);
    const req = {
      auth: {
        payload: {
          sub: "auth0|unverified",
          email: "owner@example.test",
          email_verified: false,
        },
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const res = response();

    await requireUser(req, res, vi.fn());

    expect(mocks.update).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("ACCOUNT_LINK_REQUIRED");
  });
});
