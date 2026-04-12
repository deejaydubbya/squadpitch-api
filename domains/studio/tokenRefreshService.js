// Centralized token refresh service.
//
// Three exported functions:
//  - isTokenNearExpiry(connection)    — check if token needs refresh
//  - refreshConnectionToken(connection) — perform the refresh
//  - ensureValidAccessToken(connection) — refresh-if-needed wrapper

import { prisma } from "../../prisma.js";
import { encryptToken } from "../../lib/tokenCrypto.js";
import { getRefreshAdapter } from "./token-refresh/index.js";
import { enqueueNotification } from "../notifications/notification.service.js";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

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
    console.error(
      `[TOKEN_REFRESH] Transient failure channel=${connection.channel} connectionId=${connection.id}: ${err.message}`
    );
    throw err;
  }

  // Adapter says this platform can't refresh (e.g. Meta, LinkedIn)
  if (result.canRefresh === false) {
    console.warn(
      `[TOKEN_REFRESH] Cannot refresh channel=${connection.channel} connectionId=${connection.id}${result.error ? ` — ${result.error}` : ""}`
    );
    await markNeedsReconnect(connection, result.error);
    throw Object.assign(
      new Error(
        `${connection.channel} token cannot be refreshed — user must re-authenticate`
      ),
      { status: 401, code: "TOKEN_REFRESH_IMPOSSIBLE" }
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

  await prisma.channelConnection.updateMany({
    where: { id: connection.id },
    data: updateData,
  });

  console.log(
    `[TOKEN_REFRESH] Success channel=${connection.channel} connectionId=${connection.id}`
  );

  return {
    ...connection,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? connection.refreshToken,
    tokenExpiresAt: result.expiresAt,
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
