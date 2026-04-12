// Dropbox provider — OAuth2, file listing, and file download.
//
// Config shape (stored in Integration.config):
//   {
//     accessToken: string (encrypted),
//     refreshToken: string (encrypted),
//     email: string
//   }
//
// OAuth credentials come from env:
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET

import { env } from "../../../config/env.js";
import { encryptToken, decryptToken } from "../../../lib/tokenCrypto.js";
import { prisma } from "../../../prisma.js";

const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

/**
 * Build the OAuth2 authorization URL for Dropbox.
 */
const DROPBOX_SCOPES = [
  "files.metadata.read",
  "files.content.read",
  "files.content.write",
  "account_info.read",
].join(" ");

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: env.DROPBOX_APP_KEY,
    redirect_uri: env.DROPBOX_REDIRECT_URI,
    response_type: "code",
    token_access_type: "offline",
    scope: DROPBOX_SCOPES,
    state,
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.DROPBOX_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();

  // Get user info
  const userRes = await fetch(`${API_BASE}/users/get_current_account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data.access_token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const user = userRes.ok ? await userRes.json() : {};

  return {
    accessToken: encryptToken(data.access_token),
    refreshToken: encryptToken(data.refresh_token),
    email: user.email ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh an access token.
 */
async function refreshAccessToken(integrationId, config) {
  const refreshToken = decryptToken(config.refreshToken);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const isPermanent = res.status === 400 || res.status === 401;
    if (isPermanent) {
      await prisma.integration.update({
        where: { id: integrationId },
        data: { isActive: false },
      }).catch(() => {});
      console.error(`[DROPBOX_REFRESH] Permanent failure (${res.status}) integrationId=${integrationId}: ${body.slice(0, 300)}`);
    }
    throw new Error(`Dropbox token refresh failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const newAccessToken = encryptToken(data.access_token);

  // Update stored tokens (save new refresh token if returned)
  const updatedConfig = { ...config, accessToken: newAccessToken };
  if (data.refresh_token) {
    updatedConfig.refreshToken = encryptToken(data.refresh_token);
  }

  await prisma.integration.update({
    where: { id: integrationId },
    data: { config: updatedConfig },
  });

  return data.access_token;
}

/**
 * Get a valid access token, refreshing if needed.
 */
async function getAccessToken(integrationId, config) {
  try {
    const token = decryptToken(config.accessToken);
    // Quick check
    const res = await fetch(`${API_BASE}/users/get_current_account`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return token;
  } catch {
    // Token invalid
  }

  return refreshAccessToken(integrationId, config);
}

/**
 * List files from Dropbox.
 *
 * @param {string} integrationId
 * @param {object} config
 * @param {{ path?: string, cursor?: string }} options
 * @returns {{ files: Array, cursor?: string, hasMore: boolean }}
 */
export async function listFiles(integrationId, config, { path = "", cursor } = {}) {
  const token = await getAccessToken(integrationId, config);

  let res;
  if (cursor) {
    res = await fetch(`${API_BASE}/files/list_folder/continue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cursor }),
      signal: AbortSignal.timeout(15_000),
    });
  } else {
    res = await fetch(`${API_BASE}/files/list_folder`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: path || "",
        limit: 25,
        include_media_info: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox list files failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();

  return {
    files: (data.entries || []).map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path_display,
      mimeType: guessMimeType(f.name),
      size: f.size ?? null,
      thumbnailUrl: null,
      modifiedAt: f.server_modified ?? f.client_modified,
      isFolder: f[".tag"] === "folder",
    })),
    cursor: data.cursor ?? null,
    hasMore: data.has_more ?? false,
  };
}

/**
 * Download a file from Dropbox as a Buffer.
 *
 * @param {string} integrationId
 * @param {object} config
 * @param {string} filePath — Dropbox path (e.g. "/photos/image.jpg")
 * @returns {{ buffer: Buffer, mimeType: string, filename: string }}
 */
export async function downloadFile(integrationId, config, filePath) {
  const token = await getAccessToken(integrationId, config);

  const res = await fetch(`${CONTENT_BASE}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path: filePath }),
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox download failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const meta = JSON.parse(res.headers.get("dropbox-api-result") || "{}");
  const arrayBuf = await res.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuf),
    mimeType: guessMimeType(meta.name || filePath),
    filename: meta.name || filePath.split("/").pop(),
  };
}

/**
 * Upload a file to Dropbox.
 *
 * @param {string} integrationId
 * @param {object} config
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} _mimeType — unused by Dropbox API but kept for provider interface consistency
 * @param {string} [folderPath] — optional destination path (e.g. "/exports")
 * @returns {{ id: string, name: string, path: string, size: number }}
 */
export async function uploadFile(integrationId, config, buffer, filename, _mimeType, folderPath) {
  const token = await getAccessToken(integrationId, config);

  const destPath = folderPath
    ? `${folderPath.replace(/\/$/, "")}/${filename}`
    : `/${filename}`;

  const res = await fetch(`${CONTENT_BASE}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: destPath,
        mode: "add",
        autorename: true,
        mute: false,
      }),
    },
    body: buffer,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`Dropbox upload failed (${res.status}): ${text.slice(0, 300)}`),
      { status: res.status >= 400 && res.status < 500 ? res.status : 502 }
    );
  }

  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    path: data.path_display,
    size: data.size,
  };
}

function guessMimeType(filename) {
  const ext = (filename || "").split(".").pop()?.toLowerCase();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}
