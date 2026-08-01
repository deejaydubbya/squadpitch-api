// Centralized token refresh service.
//
// Three exported functions:
//  - isTokenNearExpiry(connection)    — check if token needs refresh
//  - refreshConnectionToken(connection) — perform the refresh
//  - ensureValidAccessToken(connection) — refresh-if-needed wrapper

import { randomUUID } from "node:crypto";
import { prisma } from "../../prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import { redisCompareDelete, redisSetNX } from "../../redis.js";
import { getRefreshAdapter } from "./token-refresh/index.js";
import { enqueueNotification } from "../notifications/notification.service.js";
import { logEvent } from "../../lib/logger.js";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const inFlightRefreshes = new Map();
const REFRESH_LEASE_SECONDS = 30;
const PEER_REFRESH_WAIT_MS = 20_000;

/**
 * Returns true if the connection's access token is expired or within 5 minutes
 * of expiry. Returns false if tokenExpiresAt is null (assume valid).
 */
export function isTokenNearExpiry(connection) {
  if (!connection.tokenExpiresAt) return false;
  return new Date(connection.tokenExpiresAt) <= new Date(Date.now() + EXPIRY_BUFFER_MS);
}

/**
 * Refresh a connection's access token using the platform-specific adapter.
 * Updates the DB on success; sets NEEDS_RECONNECT on permanent failure.
 * Returns the updated connection with decrypted tokens.
 */
export async function refreshConnectionToken(connection) {
  const existing = inFlightRefreshes.get(connection.id);
  if (existing) return existing;
  const refreshPromise = coordinateRefresh(connection).finally(() => {
    if (inFlightRefreshes.get(connection.id) === refreshPromise) {
      inFlightRefreshes.delete(connection.id);
    }
  });
  inFlightRefreshes.set(connection.id, refreshPromise);
  return refreshPromise;
}

async function coordinateRefresh(connection) {
  const leaseKey = `sp:oauth:refresh-lock:${connection.id}`;
  const leaseOwner = randomUUID();
  const acquired = await redisSetNX(leaseKey, leaseOwner, REFRESH_LEASE_SECONDS);
  if (!acquired) return waitForPeerRefresh(connection);
  try {
    return await performRefresh(connection);
  } finally {
    await redisCompareDelete(leaseKey, leaseOwner);
  }
}

async function waitForPeerRefresh(connection) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < PEER_REFRESH_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const row = await prisma.channelConnection.findUnique({
      where: { id: connection.id },
    });
    if (!row) break;
    if (row.status === "NEEDS_RECONNECT") {
      throw Object.assign(new Error("Provider authorization must be renewed"), {
        status: 401,
        code: connection.channel === "PINTEREST"
          ? "PINTEREST_RECONNECT_REQUIRED"
          : "TOKEN_REFRESH_IMPOSSIBLE",
      });
    }
    if (row.lastRefreshAt && new Date(row.lastRefreshAt).getTime() >= startedAt) {
      return {
        ...row,
        accessToken: decryptToken(row.accessToken),
        refreshToken: row.refreshToken ? decryptToken(row.refreshToken) : null,
      };
    }
  }
  throw Object.assign(new Error("Token refresh is already in progress"), {
    status: 503,
    code: connection.channel === "PINTEREST"
      ? "PINTEREST_UNAVAILABLE"
      : "TOKEN_REFRESH_IN_PROGRESS",
    transient: true,
  });
}

async function performRefresh(connection) {
  const adapter = getRefreshAdapter(connection.channel);

  if (!adapter) {
    console.error(
      `[TOKEN_REFRESH] No adapter for channel=${connection.channel} connectionId=${connection.id}`
    );
    throw new Error(`No refresh adapter for ${connection.channel}`);
  }

  let result;
  try {
    result = await adapter.refresh(connection);
  } catch (err) {
    // Transient failure — log but don't corrupt existing tokens
    logEvent("token.refresh.failed", {
      channel: connection.channel,
      connectionId: connection.id,
      clientId: connection.clientId,
      reason: "transient",
      errorCode: err?.code ?? "TOKEN_REFRESH_FAILED",
    });
    throw err;
  }

  // Adapter says this platform can't refresh (e.g. Meta, LinkedIn)
  if (result.canRefresh === false) {
    logEvent("token.refresh.failed", {
      channel: connection.channel,
      connectionId: connection.id,
      clientId: connection.clientId,
      reason: "cannot_refresh",
      errorCode: result.code ?? "TOKEN_REFRESH_IMPOSSIBLE",
    });
    await markNeedsReconnect(connection, result.error);
    throw Object.assign(
      new Error(
        `${connection.channel} token cannot be refreshed — user must re-authenticate`
      ),
      { status: 401, code: result.code ?? "TOKEN_REFRESH_IMPOSSIBLE" }
    );
  }

  // Success — persist new encrypted tokens
  const updateData = {
    accessToken: encryptToken(result.accessToken),
    tokenExpiresAt: result.expiresAt,
    lastRefreshAt: new Date(),
    status: "CONNECTED",
    refreshFailedAt: null,
    lastError: null,
  };

  if (result.refreshToken) {
    updateData.refreshToken = encryptToken(result.refreshToken);
  }
  if (result.refreshTokenExpiresAt !== undefined) {
    updateData.refreshTokenExpiresAt = result.refreshTokenExpiresAt;
  }

  await prisma.channelConnection.updateMany({
    where: { id: connection.id },
    data: updateData,
  });

  logEvent("token.refresh.succeeded", {
    channel: connection.channel,
    connectionId: connection.id,
    clientId: connection.clientId,
    expiresAt: result.expiresAt ? new Date(result.expiresAt).toISOString() : null,
  });

  return {
    ...connection,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? connection.refreshToken,
    tokenExpiresAt: result.expiresAt,
    refreshTokenExpiresAt:
      result.refreshTokenExpiresAt ?? connection.refreshTokenExpiresAt ?? null,
    status: "CONNECTED",
    lastRefreshAt: new Date(),
    refreshFailedAt: null,
    lastError: null,
  };
}

/**
 * Ensure a connection has a valid (non-expired) access token.
 * If near expiry, attempts refresh. Returns the connection with fresh tokens.
 */
export async function ensureValidAccessToken(connection) {
  if (!isTokenNearExpiry(connection)) {
    return connection;
  }

  // Has a refresh token — attempt refresh
  if (connection.refreshToken) {
    return refreshConnectionToken(connection);
  }

  // No refresh token and expired — mark NEEDS_RECONNECT
  console.warn(
    `[TOKEN_REFRESH] Expired with no refresh token channel=${connection.channel} connectionId=${connection.id}`
  );
  await markNeedsReconnect(connection, "Token expired and no refresh token available");
  throw Object.assign(
    new Error(
      `${connection.channel} token expired — user must re-authenticate`
    ),
    { status: 401, code: "TOKEN_EXPIRED_NO_REFRESH" }
  );
}

// ── Internal ──────────────────────────────────────────────────────────────

async function markNeedsReconnect(connection, errorMessage) {
  await prisma.channelConnection
    .updateMany({
      where: { id: connection.id },
      data: {
        status: "NEEDS_RECONNECT",
        refreshFailedAt: new Date(),
        lastError: errorMessage ?? "Token refresh failed",
      },
    })
    .catch(() => {});

  // Fire CONNECTION_EXPIRED notification (fire-and-forget)
  prisma.user
    .findUnique({
      where: { auth0Sub: connection.createdBy },
      select: { id: true },
    })
    .then((user) => {
      if (user) {
        enqueueNotification({
          userId: user.id,
          eventType: "CONNECTION_EXPIRED",
          payload: {
            channel: connection.channel,
            clientId: connection.clientId,
          },
          resourceType: "connection",
          resourceId: `${connection.clientId}:${connection.channel}`,
        }).catch(() => {});
      }
    })
    .catch(() => {});
}
