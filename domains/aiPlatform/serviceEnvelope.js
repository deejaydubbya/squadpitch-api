import crypto from "node:crypto";
import { z } from "zod";

import { env } from "../../config/env.js";
import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";

export const AI_SERVICE_SCHEMA_VERSION = "ai-service-envelope.v1";
export const AI_SERVICE_SIGNATURE_ALGORITHM = "HMAC-SHA256";
export const AI_SERVICE_SIGNATURE_TTL_SECONDS = 60;

export const AI_SERVICE_SCOPES = Object.freeze([
  "health:read",
  "eval:run",
  "retrieval:query",
  "campaign-plan:read",
  "autopilot-rank:read",
  "content-score:read",
]);

export const AI_SERVICE_ERROR_CODES = Object.freeze({
  AUTH_SIGNATURE_MISSING: "AUTH_SIGNATURE_MISSING",
  AUTH_SIGNATURE_INVALID: "AUTH_SIGNATURE_INVALID",
  AUTH_REQUEST_EXPIRED: "AUTH_REQUEST_EXPIRED",
  AUTH_REQUEST_FUTURE_DATED: "AUTH_REQUEST_FUTURE_DATED",
  AUTH_NONCE_REPLAYED: "AUTH_NONCE_REPLAYED",
  AUTH_SCOPE_DENIED: "AUTH_SCOPE_DENIED",
  CONTRACT_UNSUPPORTED_SCHEMA_VERSION: "CONTRACT_UNSUPPORTED_SCHEMA_VERSION",
  CONTRACT_WORKSPACE_MISMATCH: "CONTRACT_WORKSPACE_MISMATCH",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_EMPTY_BODY: "PROVIDER_EMPTY_BODY",
  PROVIDER_INVALID_JSON: "PROVIDER_INVALID_JSON",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  TENANT_LEAKAGE: "TENANT_LEAKAGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

const scopeSchema = z.enum(AI_SERVICE_SCOPES);

export const aiServiceSignatureSchema = z.object({
  keyId: z.string().min(1).max(64),
  algorithm: z.literal(AI_SERVICE_SIGNATURE_ALGORITHM),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});

export const aiServiceEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(AI_SERVICE_SCHEMA_VERSION),
    requestId: z.string().min(1).max(128),
    traceId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    actorUserId: z.string().min(1).max(128),
    scopes: z.array(scopeSchema).min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    nonce: z.string().min(16).max(128),
    idempotencyKey: z.string().min(1).max(128).optional(),
    payload: z.record(z.unknown()),
    signature: aiServiceSignatureSchema,
  })
  .superRefine((value, ctx) => {
    if (new Set(value.scopes).size !== value.scopes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "scopes must be unique",
      });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after issuedAt",
      });
    }
  });

export const aiServiceErrorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  requestId: z.string().nullable(),
  traceId: z.string().nullable(),
  schemaVersion: z.string().nullable(),
  fieldErrors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
});

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortForCanonicalJson(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function canonicalizeAiServiceEnvelope(envelope) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  return JSON.stringify(sortForCanonicalJson(unsigned));
}

export function signAiServiceEnvelope(envelope, secret) {
  if (!secret) {
    throw new Error(AI_SERVICE_ERROR_CODES.PROVIDER_NOT_CONFIGURED);
  }
  return crypto
    .createHmac("sha256", secret)
    .update(canonicalizeAiServiceEnvelope(envelope))
    .digest("hex");
}

export function verifyAiServiceEnvelopeSignature(envelope, secret) {
  const parsed = aiServiceEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return false;
  const expected = signAiServiceEnvelope(parsed.data, secret);
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(parsed.data.signature.signature, "hex"),
  );
}

export function createAiServiceEnvelope({
  workspaceId,
  actorUserId,
  scopes,
  payload,
  requestId = crypto.randomUUID(),
  traceId = requestId,
  idempotencyKey,
  keyId = env.AI_PLATFORM_SERVICE_AUTH_KEY_ID,
  secret = env.AI_PLATFORM_SERVICE_AUTH_SECRET,
  now = new Date(),
  ttlSeconds = AI_SERVICE_SIGNATURE_TTL_SECONDS,
  nonce = crypto.randomBytes(24).toString("base64url"),
} = {}) {
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const envelope = {
    schemaVersion: AI_SERVICE_SCHEMA_VERSION,
    requestId,
    traceId,
    workspaceId,
    actorUserId,
    scopes,
    issuedAt,
    expiresAt,
    nonce,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    payload,
    signature: {
      keyId,
      algorithm: AI_SERVICE_SIGNATURE_ALGORITHM,
      signature: "0".repeat(64),
    },
  };
  const parsed = aiServiceEnvelopeSchema.parse(envelope);
  return {
    ...parsed,
    signature: {
      ...parsed.signature,
      signature: signAiServiceEnvelope(parsed, secret),
    },
  };
}

export function assertPayloadWorkspaceMatchesEnvelope(envelope) {
  if (
    envelope?.payload?.workspaceId != null &&
    envelope.payload.workspaceId !== envelope.workspaceId
  ) {
    const err = new Error("Payload workspace does not match envelope workspace");
    err.code = AI_SERVICE_ERROR_CODES.CONTRACT_WORKSPACE_MISMATCH;
    err.retryable = false;
    throw err;
  }
}

export async function createAuthorizedAiServiceEnvelope({
  actor,
  workspaceId,
  scopes,
  payload,
  allowAdmin = false,
  authorizationService = assertCanActorPerformWorkspaceScope,
  ...signingOptions
} = {}) {
  for (const scope of scopes ?? []) {
    await authorizationService({
      actor,
      workspaceId,
      scope,
      allowAdmin,
    });
  }
  const envelope = createAiServiceEnvelope({
    workspaceId,
    actorUserId: actor?.auth0Sub ?? actor?.sub ?? actor?.id,
    scopes,
    payload,
    ...signingOptions,
  });
  assertPayloadWorkspaceMatchesEnvelope(envelope);
  return envelope;
}
