// Google Sheets integration provider.
// Appends rows to a Google Sheet via the Sheets API.
//
// Config shape (stored in Integration.config):
//   {
//     serviceAccountEmail: string,
//     privateKey: string,          // PEM-encoded RSA private key
//     spreadsheetId: string,
//     sheetName: string            // defaults to "Sheet1"
//   }
//
// The service account must be shared as an editor on the spreadsheet.

import { SignJWT, importPKCS8 } from "jose";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// Simple in-memory token cache: email → { token, expiresAt }
const tokenCache = new Map();

/**
 * Get a Google OAuth2 access token via service account JWT.
 */
async function getAccessToken(serviceAccountEmail, privateKey) {
  const cached = tokenCache.get(serviceAccountEmail);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const key = await importPKCS8(privateKey, "RS256");

  const jwt = await new SignJWT({
    scope: SCOPE,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccountEmail)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();

  tokenCache.set(serviceAccountEmail, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  });

  return data.access_token;
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
 * @param {{ serviceAccountEmail: string, privateKey: string, spreadsheetId: string, sheetName?: string }} config
 * @param {string} eventType
 * @param {object} payload
 * @returns {{ success: boolean, updatedRange?: string }}
 */
export async function appendSheetRow(config, eventType, payload) {
  const { serviceAccountEmail, privateKey, spreadsheetId, sheetName = "Sheet1" } = config;

  const accessToken = await getAccessToken(serviceAccountEmail, privateKey);
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
    // Clear token cache on auth failure so next attempt gets a fresh token
    if (res.status === 401 || res.status === 403) {
      tokenCache.delete(serviceAccountEmail);
    }
    throw new Error(`Sheets API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  return { success: true, updatedRange: data.updates?.updatedRange };
}

/**
 * Validate a Sheets config by reading spreadsheet metadata.
 */
export async function validateSheetsConfig(config) {
  const { serviceAccountEmail, privateKey, spreadsheetId } = config;

  const accessToken = await getAccessToken(serviceAccountEmail, privateKey);

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
