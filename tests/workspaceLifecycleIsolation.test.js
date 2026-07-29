import { beforeEach, describe, expect, it, vi } from "vitest";

let client;
vi.mock("../prisma.js", () => ({
  prisma: {
    client: {
      findUnique: vi.fn(async () => client),
    },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  getAuth0Sub: (req) => req.auth.payload.sub,
}));

const { requireClientOwner } = await import("../domains/studio/ownership.js");

function invoke(actor = "auth0|owner-a") {
  const req = {
    params: { id: "workspace-a" },
    auth: { payload: { sub: actor } },
    log: { warn: vi.fn() },
  };
  const response = {
    statusCode: 200,
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
  const next = vi.fn();
  return requireClientOwner(req, response, next).then(() => ({
    response,
    next,
  }));
}

describe("workspace lifecycle isolation", () => {
  beforeEach(() => {
    client = {
      createdBy: "auth0|owner-a",
      status: "ACTIVE",
    };
  });

  it("allows only the owning identity", async () => {
    const owner = await invoke();
    expect(owner.next).toHaveBeenCalledOnce();

    const otherTenant = await invoke("auth0|owner-b");
    expect(otherTenant.next).not.toHaveBeenCalled();
    expect(otherTenant.response.statusCode).toBe(403);
  });

  it("blocks archived workspaces even for their owner", async () => {
    client.status = "ARCHIVED";
    const result = await invoke();
    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(410);
    expect(result.response.body.error).toBe("WORKSPACE_ARCHIVED");
  });
});
