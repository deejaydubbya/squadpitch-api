// AES-256-GCM encryption for OAuth tokens stored at rest.
// Format: `v1:<iv-base64>:<tag-base64>:<ciphertext-base64>`
// Key:    env.TOKEN_ENCRYPTION_KEY — base64-encoded 32 bytes.

import crypto from "node:crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw Object.assign(new Error("Token encryption key not configured"), {
      code: "TOKEN_ENCRYPTION_NOT_CONFIGURED",
      status: 500,
    });
  }
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw Object.assign(
      new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes base64"),
      { code: "TOKEN_ENCRYPTION_KEY_INVALID", status: 500 }
    );
  }
  cachedKey = key;
  return cachedKey;
}

export function encryptToken(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptToken(stored) {
  if (stored == null) return null;
  const parts = String(stored).split(":");
  if (parts.length !== 4) {
    throw Object.assign(new Error("Malformed encrypted token"), {
      code: "TOKEN_DECRYPT_MALFORMED",
      status: 500,
    });
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) {
    throw Object.assign(
      new Error(`Unsupported token cipher version ${version}`),
      { code: "TOKEN_DECRYPT_VERSION", status: 500 }
    );
  }
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}
