// Google Sheets integration provider — OAuth2.
//
// Config shape (stored in Integration.config):
//   {
//     accessToken: string (encrypted),
//     refreshToken: string (encrypted),
//     email: string,
//     spreadsheetId?: string,
//     sheetName?: string
//   }
//
// OAuth credentials come from env:
//   GOOGLE_SHEETS_CLIENT_ID, GOOGLE_SHEETS_CLIENT_SECRET, GOOGLE_SHEETS_REDIRECT_URI

import { env } from "../../../config/env.js";
import { encryptToken, decryptToken } from "../../../lib/tokenCrypto.js";
import { prisma } from "../../../prisma.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly";

/**
 * Build the OAuth2 authorization URL for Google Sheets.
 */
export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_SHEETS_CLIENT_ID,
    redirect_uri: env.GOOGLE_SHEETS_REDIRECT_URI,
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
      client_id: env.GOOGLE_SHEETS_CLIENT_ID,
      client_secret: env.GOOGLE_SHEETS_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_SHEETS_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Sheets token exchange failed (${res.status}): ${text.slice(0, 300)}`);
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
      client_id: env.GOOGLE_SHEETS_CLIENT_ID,
      client_secret: env.GOOGLE_SHEETS_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Google Sheets token refresh failed (${res.status})`);
  }

  const data = await res.json();
  const newAccessToken = encryptToken(data.access_token);

  // Update stored token
  await prisma.integration.update({
    where: { id: integrationId },
    data: { config: { ...config, accessToken: newAccessToken } },
  });

  return data.access_token;
}

/**
 * Get a valid access token, refreshing if needed.
 */
async function getAccessToken(integrationId, config) {
  try {
    const token = decryptToken(config.accessToken);
    // Test the token with a lightweight Sheets API call
    const res = await fetch(`${SHEETS_API}?fields=spreadsheetId`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    // Any non-401 means the token is still valid (even 404 is fine — token works)
    if (res.status !== 401) return token;
  } catch {
    // Token invalid, try refresh
  }

  return refreshAccessToken(integrationId, config);
}

/**
 * List spreadsheets accessible by the authenticated user.
 */
export async function listSpreadsheets(integrationId, config) {
  const token = await getAccessToken(integrationId, config);

  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: "files(id,name,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: "50",
  });

  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive list spreadsheets failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    modifiedAt: f.modifiedTime,
  }));
}

/**
 * Build a row from an event for the spreadsheet.
 * Columns: Timestamp | Event | Platform | Client | Status | Details
 */
function buildRow(eventType, payload = {}) {
  const { platformName, clientName, error, count } = payload;

  const statusMap = {
    POST_PUBLISHED: "Success",
    POST_FAILED: "Failed",
    BATCH_COMPLETE: "Complete",
    CONNECTION_EXPIRED: "Warning",
    USAGE_LIMIT_NEARING: "Warning",
    TEST: "Test",
  };

  let details = "";
  if (error) details = error;
  else if (count) details = `${count} posts`;

  return [
    new Date().toISOString(),
    eventType,
    platformName || "",
    clientName || "",
    statusMap[eventType] || eventType,
    details,
  ];
}

/**
 * Append a row to a Google Sheet.
 *
 * @param {string} integrationId
 * @param {object} config — { accessToken, refreshToken, email, spreadsheetId, sheetName }
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, updatedRange?: string }}
 */
export async function appendSheetRow(integrationId, config, eventType, payload) {
  const { spreadsheetId, sheetName = "Sheet1" } = config;

  if (!spreadsheetId) {
    throw new Error("Sheets integration missing spreadsheetId");
  }

  const accessToken = await getAccessToken(integrationId, config);
  const range = encodeURIComponent(`${sheetName}!A:F`);

  const url = `${SHEETS_API}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      values: [buildRow(eventType, payload)],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`Sheets API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  return { success: true, updatedRange: data.updates?.updatedRange };
}

/**
 * Validate a Sheets config by reading spreadsheet metadata.
 */
export async function validateSheetsConfig(integrationId, config) {
  const { spreadsheetId } = config;

  if (!spreadsheetId) {
    throw new Error("Sheets integration missing spreadsheetId");
  }

  const accessToken = await getAccessToken(integrationId, config);

  const res = await fetch(`${SHEETS_API}/${spreadsheetId}?fields=properties.title`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sheets validation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return { valid: true };
}
