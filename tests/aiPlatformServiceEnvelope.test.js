import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AI_SERVICE_ERROR_CODES,
  AI_SERVICE_SCHEMA_VERSION,
  AI_SERVICE_SCOPES,
  aiServiceEnvelopeSchema,
  aiServiceErrorEnvelopeSchema,
  assertPayloadWorkspaceMatchesEnvelope,
  canonicalizeAiServiceEnvelope,
  createAiServiceEnvelope,
  verifyAiServiceEnvelopeSignature,
} from "../domains/aiPlatform/serviceEnvelope.js";

const SECRET_V1 = "node-python-service-secret-v1";
const SECRET_V2 = "node-python-service-secret-v2";

function makeEnvelope(overrides = {}) {
  return createAiServiceEnvelope({
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    scopes: ["eval:run"],
    payload: { workspaceId: "workspace-1", task: "noop" },
    requestId: "req-1",
    traceId: "trace-1",
    keyId: "v1",
    secret: SECRET_V1,
    now: new Date("2026-07-22T12:00:00.000Z"),
    nonce: "nonce-1234567890abcdef",
    ...overrides,
  });
}

describe("AI service envelope contract", () => {
  it("creates a valid signed envelope", () => {
    const envelope = makeEnvelope();

    expect(aiServiceEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(verifyAiServiceEnvelopeSignature(envelope, SECRET_V1)).toBe(true);
    expect(envelope.signature.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects invalid signatures", () => {
    const envelope = makeEnvelope();
    const tampered = { ...envelope, payload: { ...envelope.payload, task: "changed" } };

    expect(verifyAiServiceEnvelopeSignature(tampered, SECRET_V1)).toBe(false);
  });

  it("supports key rotation by validating against the matching key id", () => {
    const v1 = makeEnvelope({ keyId: "v1", secret: SECRET_V1 });
    const v2 = makeEnvelope({ keyId: "v2", secret: SECRET_V2, nonce: "nonce-2234567890abcdef" });

    expect(verifyAiServiceEnvelopeSignature(v1, SECRET_V1)).toBe(true);
    expect(verifyAiServiceEnvelopeSignature(v2, SECRET_V2)).toBe(true);
    expect(verifyAiServiceEnvelopeSignature(v2, SECRET_V1)).toBe(false);
  });

  it("fails validation when signature metadata is missing", () => {
    const envelope = makeEnvelope();
    const { signature, ...missingSignature } = envelope;

    expect(signature).toBeTruthy();
    expect(aiServiceEnvelopeSchema.safeParse(missingSignature).success).toBe(false);
  });

  it("detects cross-workspace payload mismatch before a service call", () => {
    const envelope = makeEnvelope({ payload: { workspaceId: "workspace-2" } });

    expect(() => assertPayloadWorkspaceMatchesEnvelope(envelope)).toThrow(
      "Payload workspace does not match envelope workspace",
    );
  });

  it("keeps the checked-in JSON Schema aligned with Node constants", () => {
    const schemaPath = path.resolve(
      process.cwd(),
      "docs",
      "ai-platform",
      "contracts",
      "v1",
      "service-envelope.schema.json",
    );
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    expect(schema.properties.schemaVersion.const).toBe(AI_SERVICE_SCHEMA_VERSION);
    expect(schema.properties.scopes.items.enum).toEqual(AI_SERVICE_SCOPES);
  });

  it("exposes a stable caller-safe error envelope contract", () => {
    const parsed = aiServiceErrorEnvelopeSchema.parse({
      code: AI_SERVICE_ERROR_CODES.AUTH_SCOPE_DENIED,
      message: "Required scope is missing",
      retryable: false,
      requestId: "req-1",
      traceId: "trace-1",
      schemaVersion: AI_SERVICE_SCHEMA_VERSION,
    });

    expect(parsed).not.toHaveProperty("stack");
  });

  it("canonicalizes object keys for Node/Python compatibility", () => {
    const envelope = makeEnvelope({
      payload: { z: 1, a: { c: 3, b: 2 }, workspaceId: "workspace-1" },
    });

    expect(canonicalizeAiServiceEnvelope(envelope)).toBe(
      '{"actorUserId":"user-1","expiresAt":"2026-07-22T12:01:00.000Z","issuedAt":"2026-07-22T12:00:00.000Z","nonce":"nonce-1234567890abcdef","payload":{"a":{"b":2,"c":3},"workspaceId":"workspace-1","z":1},"requestId":"req-1","schemaVersion":"ai-service-envelope.v1","scopes":["eval:run"],"traceId":"trace-1","workspaceId":"workspace-1"}',
    );
  });
});
