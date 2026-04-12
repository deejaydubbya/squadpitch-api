// Google Drive provider — OAuth2, file listing, and file download.
//
// Config shape (stored in Integration.config):
//   {
//     accessToken: string (encrypted),
//     refreshToken: string (encrypted),
//     email: string
//   }
//
// OAuth credentials come from env:
//   GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET

import { env } from "../../../config/env.js";
import { encryptToken, decryptToken } from "../../../lib/tokenCrypto.js";
import { prisma } from "../../../prisma.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";

/**
 * Build the OAuth2 authorization URL for Google Drive.
 */
export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_DRIVE_CLIENT_ID,
    redirect_uri: env.GOOGLE_DRIVE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_DRIVE_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Drive token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();

  // Get user email
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
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
      client_id: env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET,
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
      console.error(`[DRIVE_REFRESH] Permanent failure (${res.status}) integrationId=${integrationId}: ${body.slice(0, 300)}`);
    }
    throw new Error(`Google Drive token refresh failed (${res.status}): ${body.slice(0, 300)}`);
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
    // Test the token
    const res = await fetch(`${DRIVE_API}/about?fields=user`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return token;
  } catch {
    // Token invalid, try refresh
  }

  return refreshAccessToken(integrationId, config);
}

/**
 * List files from Google Drive.
 *
 * @param {string} integrationId
 * @param {object} config
 * @param {{ folderId?: string, pageToken?: string, pageSize?: number }} options
 * @returns {{ files: Array, nextPageToken?: string }}
 */
export async function listFiles(integrationId, config, { folderId, pageToken, pageSize = 20 } = {}) {
  const token = await getAccessToken(integrationId, config);

  const q = folderId
    ? `'${folderId}' in parents and trashed = false`
    : "'root' in parents and trashed = false";

  const params = new URLSearchParams({
    q,
    fields: "nextPageToken,files(id,name,mimeType,size,thumbnailLink,modifiedTime,iconLink)",
    pageSize: String(pageSize),
    orderBy: "folder,name",
  });
  if (pageToken) params.set("pageToken", pageToken);

  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive list files failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    files: (data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? parseInt(f.size) : null,
      thumbnailUrl: f.thumbnailLink ?? null,
      modifiedAt: f.modifiedTime,
      isFolder: f.mimeType === "application/vnd.google-apps.folder",
    })),
    nextPageToken: data.nextPageToken ?? null,
  };
}

/**
 * Download a file from Google Drive as a Buffer.
 *
 * @param {string} integrationId
 * @param {object} config
 * @param {string} fileId
 * @returns {{ buffer: Buffer, mimeType: string, filename: string }}
 */
export async function downloadFile(integrationId, config, fileId) {
  const token = await getAccessToken(integrationId, config);

  // Get file metadata first
  const metaRes = await fetch(`${DRIVE_API}/files/${fileId}?fields=name,mimeType,size`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!metaRes.ok) throw new Error(`Drive get file meta failed (${metaRes.status})`);
  const meta = await metaRes.json();

  // Download content
  const dlRes = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!dlRes.ok) throw new Error(`Drive download failed (${dlRes.status})`);

  const arrayBuf = await dlRes.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuf),
    mimeType: meta.mimeType,
    filename: meta.name,
  };
}

/**
 * Upload a file to Google Drive.
 *
 * @param {string} integrationId
 * @param {object} config
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimeType
 * @param {string} [folderId] — optional parent folder ID
 * @returns {{ id: string, name: string, webViewLink: string }}
 */
export async function uploadFile(integrationId, config, buffer, filename, mimeType, folderId) {
  const token = await getAccessToken(integrationId, config);

  // Use multipart upload: metadata + file content
  const boundary = "squadpitch_upload_boundary";

  const metadata = {
    name: filename,
    ...(folderId ? { parents: [folderId] } : {}),
  };

  const metadataStr = JSON.stringify(metadata);

  // Build multipart body
  const preamble = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--`;

  const preambleBuf = Buffer.from(preamble, "utf-8");
  const epilogueBuf = Buffer.from(epilogue, "utf-8");
  const body = Buffer.concat([preambleBuf, buffer, epilogueBuf]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
      signal: AbortSignal.timeout(120_000),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403) {
      throw Object.assign(
        new Error("Google Drive permission denied. Please reconnect Google Drive to grant write access."),
        { status: 403 }
      );
    }
    throw Object.assign(
      new Error(`Drive upload failed (${res.status}): ${text.slice(0, 300)}`),
      { status: res.status }
    );
  }

  return res.json();
}
