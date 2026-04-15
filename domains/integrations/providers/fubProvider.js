// Follow Up Boss CRM Provider — API key auth + REST API.
//
// Follow Up Boss uses HTTP Basic Auth with the API key as the username
// and blank password. Docs: https://docs.followupboss.com/
//
// Config shape (stored in WorkspaceTechStackConnection.metadataJson):
//   {
//     apiKey: string (encrypted),
//     systemKey: string (optional, for webhooks),
//     lastSyncedAt: string,
//     contactCount: number,
//     dealCount: number,
//   }

import { encryptToken, decryptToken } from "../../../lib/tokenCrypto.js";

const FUB_BASE = "https://api.followupboss.com/v1";
const REQUEST_TIMEOUT = 15_000;

// ── Auth ────────────────────────────────────────────────────────────────

/**
 * Build authorization header from encrypted API key.
 */
function getAuthHeader(config) {
  const apiKey = decryptToken(config.apiKey);
  const encoded = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Validate an API key by making a test request.
 * @returns {{ valid: boolean, userName?: string, error?: string }}
 */
export async function validateApiKey(apiKey) {
  try {
    const encoded = Buffer.from(`${apiKey}:`).toString("base64");
    const res = await fetch(`${FUB_BASE}/me`, {
      headers: {
        Authorization: `Basic ${encoded}`,
        "X-System": "Squadpitch",
        "X-System-Key": "squadpitch-integration",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (res.ok) {
      const data = await res.json();
      return { valid: true, userName: data.name || data.email || null };
    }
    if (res.status === 401) {
      return { valid: false, error: "Invalid API key" };
    }
    return { valid: false, error: `API error (${res.status})` };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Encrypt and store an API key.
 */
export function encryptApiKey(apiKey) {
  return encryptToken(apiKey);
}

// ── API Calls ──────────────────────────────────────────────────────────

/**
 * Generic FUB API request helper.
 */
async function fubFetch(config, endpoint, params = {}) {
  const url = new URL(`${FUB_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: getAuthHeader(config),
      "X-System": "Squadpitch",
      "X-System-Key": "squadpitch-integration",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw Object.assign(new Error("CRM authentication failed — check API key"), { permanent: true });
    }
    if (res.status === 429) {
      throw Object.assign(new Error("CRM rate limit exceeded — try again later"), { status: 429 });
    }
    throw new Error(`FUB API error (${res.status})`);
  }

  return res.json();
}

/**
 * Fetch people (contacts) from Follow Up Boss.
 * @returns {Promise<{ people: Array, total: number }>}
 */
export async function fetchPeople(config, { limit = 100, offset = 0, updatedAfter } = {}) {
  const params = { limit, offset, sort: "-updated" };
  if (updatedAfter) params.updatedAfter = updatedAfter;

  const data = await fubFetch(config, "/people", params);
  return {
    people: (data.people || []).map(normalizePerson),
    total: data._metadata?.total || 0,
  };
}

/**
 * Fetch deals from Follow Up Boss.
 * @returns {Promise<{ deals: Array, total: number }>}
 */
export async function fetchDeals(config, { limit = 100, offset = 0, updatedAfter } = {}) {
  const params = { limit, offset, sort: "-updated" };
  if (updatedAfter) params.updatedAfter = updatedAfter;

  const data = await fubFetch(config, "/deals", params);
  return {
    deals: (data.deals || []).map(normalizeDeal),
    total: data._metadata?.total || 0,
  };
}

/**
 * Fetch notes for a person.
 * @returns {Promise<{ notes: Array }>}
 */
export async function fetchNotes(config, personId, { limit = 50 } = {}) {
  const data = await fubFetch(config, "/notes", { personId, limit });
  return {
    notes: (data.notes || []).map(normalizeNote),
  };
}

/**
 * Fetch events/tasks from Follow Up Boss.
 * @returns {Promise<{ events: Array }>}
 */
export async function fetchEvents(config, { limit = 50, updatedAfter } = {}) {
  const params = { limit, sort: "-updated" };
  if (updatedAfter) params.updatedAfter = updatedAfter;

  const data = await fubFetch(config, "/events", params);
  return {
    events: (data.events || []).map(normalizeEvent),
  };
}

// ── Normalizers ─────────────────────────────────────────────────────────

function normalizePerson(p) {
  return {
    id: p.id,
    firstName: p.firstName || null,
    lastName: p.lastName || null,
    name: [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown",
    email: p.emails?.[0]?.value || null,
    phone: p.phones?.[0]?.value || null,
    stage: p.stage || null, // Lead, Active, Under Contract, Closed, etc.
    source: p.source || null,
    tags: p.tags || [],
    addresses: (p.addresses || []).map((a) => ({
      street: a.street || null,
      city: a.city || null,
      state: a.state || null,
      zip: a.code || null,
    })),
    created: p.created || null,
    updated: p.updated || null,
  };
}

function normalizeDeal(d) {
  return {
    id: d.id,
    personId: d.personId || null,
    personName: d.personName || null,
    dealType: d.dealType || null, // Buying, Selling
    stage: d.stage || null, // New, Under Contract, Closed, Lost
    price: d.price || null,
    address: d.propertyAddress || d.address || null,
    closingDate: d.closingDate || null,
    source: d.source || null,
    created: d.created || null,
    updated: d.updated || null,
  };
}

function normalizeNote(n) {
  return {
    id: n.id,
    personId: n.personId || null,
    body: n.body || "",
    subject: n.subject || null,
    created: n.created || null,
  };
}

function normalizeEvent(e) {
  return {
    id: e.id,
    personId: e.personId || null,
    type: e.type || null,
    description: e.description || null,
    created: e.created || null,
  };
}
