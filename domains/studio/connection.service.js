// Squadpitch channel connections.
//
// Owns the ChannelConnection model. All access/refresh tokens
// are encrypted at rest via lib/tokenCrypto.js. `formatConnection()` NEVER
// returns raw tokens — they're only decrypted via `getConnectionForAdapter()`
// which is an internal API used by the publishing pipeline.

import { prisma } from "../../prisma.js";
import { encryptToken, decryptToken } from "../../lib/tokenCrypto.js";
import { enqueueNotification } from "../notifications/notification.service.js";
import { ensureValidAccessToken } from "./tokenRefreshService.js";

export async function listConnections(clientId) {
  await checkAndUpdateExpiredConnections(clientId);
  const rows = await prisma.channelConnection.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(formatConnection);
}

export async function getConnection(clientId, channel) {
  return prisma.channelConnection.findUnique({
    where: { clientId_channel: { clientId, channel } },
  });
}

/**
 * Internal: returns a connection with DECRYPTED tokens, for adapter use.
 * Never expose this output to the network — use `formatConnection()` for
 * API responses.
 */
export async function getConnectionForAdapter(clientId, channel) {
  const row = await getConnection(clientId, channel);
  if (!row) return null;
  return {
    ...row,
    accessToken: decryptToken(row.accessToken),
    refreshToken: row.refreshToken ? decryptToken(row.refreshToken) : null,
  };
}

export async function upsertConnection({
  clientId,
  channel,
  accessToken,
  refreshToken,
  tokenExpiresAt,
  scopes,
  externalAccountId,
  displayName,
  createdBy,
}) {
  const encryptedAccess = encryptToken(accessToken);
  const encryptedRefresh = refreshToken == null ? null : encryptToken(refreshToken);

  const data = {
    accessToken: encryptedAccess,
    refreshToken: encryptedRefresh,
    tokenExpiresAt: tokenExpiresAt ?? null,
    scopes: scopes ?? [],
    externalAccountId: externalAccountId ?? null,
    displayName: displayName ?? null,
    status: "CONNECTED",
    lastValidatedAt: new Date(),
    lastError: null,
  };

  return prisma.channelConnection.upsert({
    where: { clientId_channel: { clientId, channel } },
    create: {
      clientId,
      channel,
      createdBy,
      ...data,
    },
    update: data,
  });
}

export async function deleteConnection(clientId, channel) {
  return prisma.channelConnection.deleteMany({
    where: { clientId, channel },
  });
}

export async function updateConnectionStatus(
  clientId,
  channel,
  { status, lastError, lastValidatedAt }
) {
  return prisma.channelConnection.updateMany({
    where: { clientId, channel },
    data: {
      ...(status !== undefined && { status }),
      ...(lastError !== undefined && { lastError }),
      ...(lastValidatedAt !== undefined && { lastValidatedAt }),
    },
  });
}

/**
 * Batch-expire connections whose tokenExpiresAt has passed AND have no
 * refresh token (Meta, LinkedIn). Connections with refresh tokens (YouTube,
 * X, TikTok) are auto-refreshed at publish time — marking them EXPIRED here
 * would be a false alarm since their access tokens expire every 1-2 hours
 * but the refresh token keeps them alive.
 */
export async function checkAndUpdateExpiredConnections(clientId) {
  // Only expire connections that have NO refresh token — those truly need
  // re-authentication when the access token expires.
  const expiring = await prisma.channelConnection.findMany({
    where: {
      clientId,
      status: "CONNECTED",
      tokenExpiresAt: { lt: new Date() },
      refreshToken: null,
    },
    select: { channel: true, createdBy: true },
  });

  if (!expiring.length) return { count: 0 };

  const result = await prisma.channelConnection.updateMany({
    where: {
      clientId,
      status: "CONNECTED",
      tokenExpiresAt: { lt: new Date() },
      refreshToken: null,
    },
    data: { status: "EXPIRED" },
  });

  // Fire-and-forget notifications for each expired connection
  for (const conn of expiring) {
    prisma.user
      .findUnique({ where: { auth0Sub: conn.createdBy }, select: { id: true } })
      .then((user) => {
        if (user) {
          enqueueNotification({
            userId: user.id,
            eventType: "CONNECTION_EXPIRED",
            payload: { channel: conn.channel, clientId },
            resourceType: "connection",
            resourceId: `${clientId}:${conn.channel}`,
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }

  return result;
}

/**
 * Validate a connection by checking token expiry and (for INSTAGRAM)
 * making a lightweight Graph API call to verify the token works.
 */
export async function validateConnection(clientId, channel) {
  let conn = await getConnectionForAdapter(clientId, channel);
  if (!conn) return { valid: false, status: "NOT_FOUND", error: "Connection not found" };

  // Check token expiry — attempt refresh if a refresh token exists.
  if (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) < new Date()) {
    if (conn.refreshToken) {
      try {
        conn = await ensureValidAccessToken(conn);
      } catch {
        // Refresh failed — connection is now NEEDS_RECONNECT (set by tokenRefreshService)
        return { valid: false, status: "NEEDS_RECONNECT", error: "Token refresh failed — please reconnect" };
      }
    } else {
      await updateConnectionStatus(clientId, channel, { status: "EXPIRED" });
      return { valid: false, status: "EXPIRED" };
    }
  }

  // Channel-specific live validation endpoints.
  const VALIDATION_ENDPOINTS = {
    INSTAGRAM: (token) =>
      `https://graph.instagram.com/me?fields=id&access_token=${encodeURIComponent(token)}`,
    FACEBOOK: (token) =>
      `https://graph.facebook.com/v19.0/me?fields=id&access_token=${encodeURIComponent(token)}`,
    LINKEDIN: (token) => ({
      url: "https://api.linkedin.com/v2/userinfo",
      headers: { Authorization: `Bearer ${token}` },
    }),
    X: (token) => ({
      url: "https://api.x.com/2/users/me",
      headers: { Authorization: `Bearer ${token}` },
    }),
    TIKTOK: (token) => ({
      url: "https://open.tiktokapis.com/v2/user/info/?fields=open_id",
      headers: { Authorization: `Bearer ${token}` },
    }),
    YOUTUBE: (token) => ({
      url: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      headers: { Authorization: `Bearer ${token}` },
    }),
  };

  const endpointFactory = VALIDATION_ENDPOINTS[channel];
  if (!endpointFactory) {
    // Unknown channel — fall back to stored status check.
    return { valid: conn.status === "CONNECTED", status: conn.status };
  }

  try {
    const endpoint = endpointFactory(conn.accessToken);
    const fetchUrl = typeof endpoint === "string" ? endpoint : endpoint.url;
    const fetchOpts =
      typeof endpoint === "string" ? {} : { headers: endpoint.headers };

    const resp = await fetch(fetchUrl, fetchOpts);
    if (resp.ok) {
      await updateConnectionStatus(clientId, channel, {
        lastValidatedAt: new Date(),
      });
      return { valid: true, status: "CONNECTED" };
    }

    const body = await resp.json().catch(() => ({}));
    const errorMsg =
      body?.error?.message ?? body?.message ?? `${channel} API returned ${resp.status}`;
    await updateConnectionStatus(clientId, channel, {
      status: "ERROR",
      lastError: errorMsg,
    });
    return { valid: false, status: "ERROR", error: errorMsg };
  } catch (err) {
    const errorMsg = err?.message ?? `${channel} validation failed`;
    await updateConnectionStatus(clientId, channel, {
      status: "ERROR",
      lastError: errorMsg,
    });
    return { valid: false, status: "ERROR", error: errorMsg };
  }
}

/**
 * Format a connection for API responses. NEVER includes raw tokens.
 */
export function formatConnection(conn) {
  if (!conn) return null;
  return {
    id: conn.id,
    clientId: conn.clientId,
    channel: conn.channel,
    externalAccountId: conn.externalAccountId,
    displayName: conn.displayName,
    scopes: conn.scopes ?? [],
    status: conn.status,
    tokenExpiresAt: conn.tokenExpiresAt,
    lastValidatedAt: conn.lastValidatedAt,
    lastError: conn.lastError,
    createdBy: conn.createdBy,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}
