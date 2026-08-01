import { beforeEach, describe, expect, it, vi } from "vitest";

const nonces = new Map();
vi.mock("../config/env.js", () => ({
  env: { OAUTH_STATE_SECRET: "test-state-secret-at-least-32-characters" },
}));
vi.mock("../redis.js", () => ({
  redisSet: vi.fn(async (key, value) => {
    nonces.set(key, value);
  }),
  redisGet: vi.fn(async (key) => nonces.get(key) ?? null),
  redisDel: vi.fn(async (key) => {
    nonces.delete(key);
  }),
}));

const { signState, verifyState } =
  await import("../domains/studio/oauth/oauthStateCodec.js");

describe("OAuth state transitions", () => {
  beforeEach(() => {
    nonces.clear();
    vi.useRealTimers();
  });

  it("round-trips the workspace/channel and consumes state once", async () => {
    const { token } = await signState({
      clientId: "workspace-a",
      channel: "FACEBOOK",
      actorSub: "auth0|user-a",
    });
    await expect(verifyState(token, { actorSub: "auth0|user-a" })).resolves.toMatchObject({
      clientId: "workspace-a",
      channel: "FACEBOOK",
    });
    await expect(verifyState(token, { actorSub: "auth0|user-a" })).rejects.toMatchObject({
      code: "INVALID_OAUTH_STATE",
    });
  });

  it("rejects a tampered state before consuming its nonce", async () => {
    const { token } = await signState({
      clientId: "workspace-a",
      channel: "INSTAGRAM",
      actorSub: "auth0|user-a",
    });
    const [payload, signature] = token.split(".");
    const tampered = `${payload.slice(0, -1)}A.${signature}`;
    await expect(verifyState(tampered, { actorSub: "auth0|user-a" })).rejects.toMatchObject({
      code: "INVALID_OAUTH_STATE",
    });
    await expect(verifyState(token, { actorSub: "auth0|user-a" })).resolves.toMatchObject({
      clientId: "workspace-a",
    });
  });

  it("rejects expired state even when the nonce still exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
    const { token } = await signState({
      clientId: "workspace-a",
      channel: "YOUTUBE",
      actorSub: "auth0|user-a",
    });
    vi.setSystemTime(new Date("2026-07-29T12:11:00Z"));
    await expect(verifyState(token, { actorSub: "auth0|user-a" })).rejects.toMatchObject({
      code: "INVALID_OAUTH_STATE",
    });
  });

  it("rejects completion by a different authenticated user", async () => {
    const { token } = await signState({
      clientId: "workspace-a",
      channel: "PINTEREST",
      actorSub: "auth0|initiator",
    });
    await expect(
      verifyState(token, { actorSub: "auth0|different-user" }),
    ).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
  });
});
