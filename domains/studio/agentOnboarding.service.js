// Agent onboarding service — RE-specific source extraction and merge.
//
// Extracts agent profile data from multiple sources (Zillow, license lookup,
// CRM CSV) and merges into a single AgentProfileDraft for AI brand extraction.

import { generateStructuredContent } from "./generation/openai.provider.js";
import { scrapeUrl } from "./scrapeUrl.js";

/**
 * @typedef {Object} AgentProfileDraft
 * @property {string} sourceType - 'website'|'zillow_profile'|'license_lookup'|'crm_import'|'documents'|'manual'
 * @property {string} [agentName]
 * @property {string} [brokerageName]
 * @property {string} [teamName]
 * @property {string} [bio]
 * @property {string[]} [specialties]
 * @property {string[]} [serviceAreas]
 * @property {string} [primaryCity]
 * @property {string} [primaryState]
 * @property {string} [licenseNumber]
 * @property {string} [licenseState]
 * @property {string} [licenseStatus]
 * @property {string} [websiteUrl]
 * @property {string} [zillowProfileUrl]
 * @property {{ instagram?: string, facebook?: string, linkedin?: string, youtube?: string }} [socialLinks]
 * @property {Array<{ address?: string, city?: string, state?: string, price?: number }>} [exampleListings]
 * @property {string[]} [inferredAudience]
 * @property {string[]} [inferredPriceBands]
 * @property {string[]} [notes]
 * @property {Record<string, number>} [confidence]
 */

const EXTRACTION_TEMPERATURE = 0.3;
const EXTRACTION_TIMEOUT_MS = 60_000;

// ── Zillow extraction ────────────────────────────────────────────────────

const ZILLOW_EXTRACTION_SYSTEM = `You are extracting structured agent profile data from a Zillow agent profile page.
Return a JSON object with the following fields (all optional — include only what you can find):
- agentName: the agent's full name
- brokerageName: the brokerage or team they belong to
- teamName: the specific team name if different from brokerage
- bio: agent's bio or description
- specialties: array of specialties (e.g. "Buyer's Agent", "Listing Agent", "Relocation")
- serviceAreas: array of service areas / neighborhoods / cities
- primaryCity: primary city they serve
- primaryState: primary state (2-letter abbreviation)
- licenseNumber: real estate license number if shown
- licenseState: license state abbreviation
- websiteUrl: agent's personal website if shown
- socialLinks: object with instagram, facebook, linkedin, youtube URLs
- exampleListings: array of recent listings with { address, city, state, price }
- inferredAudience: array of audience types (e.g. "First-time buyers", "Luxury buyers")
- inferredPriceBands: array of price ranges (e.g. "$300K-$500K", "$500K-$1M")

Be thorough but only include data actually present on the page.`;

const ZILLOW_EXTRACTION_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "zillow_agent_profile",
    strict: true,
    schema: {
      type: "object",
      properties: {
        agentName: { type: "string" },
        brokerageName: { type: "string" },
        teamName: { type: "string" },
        bio: { type: "string" },
        specialties: { type: "array", items: { type: "string" } },
        serviceAreas: { type: "array", items: { type: "string" } },
        primaryCity: { type: "string" },
        primaryState: { type: "string" },
        licenseNumber: { type: "string" },
        licenseState: { type: "string" },
        websiteUrl: { type: "string" },
        socialLinks: {
          type: "object",
          properties: {
            instagram: { type: "string" },
            facebook: { type: "string" },
            linkedin: { type: "string" },
            youtube: { type: "string" },
          },
          required: ["instagram", "facebook", "linkedin", "youtube"],
          additionalProperties: false,
        },
        exampleListings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              address: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              price: { type: "number" },
            },
            required: ["address", "city", "state", "price"],
            additionalProperties: false,
          },
        },
        inferredAudience: { type: "array", items: { type: "string" } },
        inferredPriceBands: { type: "array", items: { type: "string" } },
      },
      required: [
        "agentName", "brokerageName", "teamName", "bio",
        "specialties", "serviceAreas", "primaryCity", "primaryState",
        "licenseNumber", "licenseState", "websiteUrl", "socialLinks",
        "exampleListings", "inferredAudience", "inferredPriceBands",
      ],
      additionalProperties: false,
    },
  },
};

/**
 * Extract agent profile data from a Zillow agent profile URL.
 * @param {string} url - Zillow agent profile URL
 * @returns {Promise<AgentProfileDraft>}
 */
export async function extractFromZillow(url) {
  const scraped = await scrapeUrl(url);
  if (!scraped.text || scraped.text.length < 50) {
    throw new Error("Could not extract content from Zillow profile URL");
  }

  const result = await generateStructuredContent({
    systemPrompt: ZILLOW_EXTRACTION_SYSTEM,
    userPrompt: `Extract agent profile data from this Zillow profile page:\n\n${scraped.text.slice(0, 100_000)}\n\nSource URL: ${url}`,
    responseFormat: ZILLOW_EXTRACTION_FORMAT,
    taskType: "parsing",
    temperature: EXTRACTION_TEMPERATURE,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

  const data = result.parsed;

  // Clean empty strings from strict schema
  const clean = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
  const cleanArr = (v) => (Array.isArray(v) && v.length > 0 ? v.filter(Boolean) : undefined);
  const cleanLinks = (v) => {
    if (!v) return undefined;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (val && val.trim()) out[k] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  return {
    sourceType: "zillow_profile",
    agentName: clean(data.agentName),
    brokerageName: clean(data.brokerageName),
    teamName: clean(data.teamName),
    bio: clean(data.bio),
    specialties: cleanArr(data.specialties),
    serviceAreas: cleanArr(data.serviceAreas),
    primaryCity: clean(data.primaryCity),
    primaryState: clean(data.primaryState),
    licenseNumber: clean(data.licenseNumber),
    licenseState: clean(data.licenseState),
    websiteUrl: clean(data.websiteUrl),
    zillowProfileUrl: url,
    socialLinks: cleanLinks(data.socialLinks),
    exampleListings: Array.isArray(data.exampleListings) && data.exampleListings.length > 0
      ? data.exampleListings : undefined,
    inferredAudience: cleanArr(data.inferredAudience),
    inferredPriceBands: cleanArr(data.inferredPriceBands),
    confidence: { agentName: 0.9, serviceAreas: 0.8, specialties: 0.7 },
  };
}

// ── License lookup ──────────────────────────────────────────────────────

/**
 * License lookup adapter registry (scaffold — actual state API integration is follow-up).
 * Each entry stores known public lookup URL for reference.
 */
const LICENSE_ADAPTERS = {
  CA: { name: "California DRE", url: "https://www2.dre.ca.gov/PublicASP/pplinfo.asp" },
  TX: { name: "Texas TREC", url: "https://www.trec.texas.gov/apps/license-holder-search" },
  FL: { name: "Florida DBPR", url: "https://www.myfloridalicense.com/wl11.asp" },
  NY: { name: "New York DOS", url: "https://appext20.dos.ny.gov/nydos/" },
  IL: { name: "Illinois IDFPR", url: "https://online-dfpr.com/Lookup/LicenseLookup.aspx" },
};

/**
 * Look up a real estate license. V1 is a scaffold — stores the license info
 * but doesn't actually query state databases.
 * @param {string} state - 2-letter state abbreviation
 * @param {string} licenseNumber - License number
 * @returns {Promise<AgentProfileDraft>}
 */
export async function extractFromLicense(state, licenseNumber) {
  const adapter = LICENSE_ADAPTERS[state.toUpperCase()];

  return {
    sourceType: "license_lookup",
    licenseNumber,
    licenseState: state.toUpperCase(),
    licenseStatus: adapter ? "pending_verification" : "unknown",
    primaryState: state.toUpperCase(),
    notes: [
      adapter
        ? `License lookup available via ${adapter.name} (${adapter.url}) — automated verification coming soon`
        : `No automated lookup available for ${state.toUpperCase()} — license info stored as-is`,
    ],
    confidence: { licenseNumber: 1, licenseState: 1, licenseStatus: 0 },
  };
}

// ── CRM CSV analysis ────────────────────────────────────────────────────

const CRM_ANALYSIS_SYSTEM = `You are analyzing a CSV export from a real estate CRM system. The data may contain contacts, leads, transactions, or client records.

Analyze the data patterns to infer the agent's:
- serviceAreas: cities/neighborhoods where they work (from addresses, locations)
- inferredPriceBands: typical price ranges (from transaction amounts, listing prices)
- inferredAudience: client types (e.g. "First-time buyers", "Investors", "Sellers", "Luxury buyers")
- specialties: inferred specialties (e.g. "Residential", "Commercial", "Condos")
- primaryCity: most common city
- primaryState: most common state (2-letter)
- notes: any other useful observations about the agent's business

Only include fields you can reasonably infer from the data. Be conservative.`;

const CRM_ANALYSIS_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "crm_analysis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        serviceAreas: { type: "array", items: { type: "string" } },
        inferredPriceBands: { type: "array", items: { type: "string" } },
        inferredAudience: { type: "array", items: { type: "string" } },
        specialties: { type: "array", items: { type: "string" } },
        primaryCity: { type: "string" },
        primaryState: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
      },
      required: [
        "serviceAreas", "inferredPriceBands", "inferredAudience",
        "specialties", "primaryCity", "primaryState", "notes",
      ],
      additionalProperties: false,
    },
  },
};

/**
 * Analyze a CRM CSV export to infer agent profile data.
 * @param {string} csvText - Raw CSV text content
 * @returns {Promise<AgentProfileDraft>}
 */
export async function extractFromCrm(csvText) {
  if (!csvText || csvText.trim().length < 20) {
    throw new Error("CSV content is too short to analyze");
  }

  // Truncate to avoid token limits — send first ~100K chars
  const truncated = csvText.slice(0, 100_000);

  const result = await generateStructuredContent({
    systemPrompt: CRM_ANALYSIS_SYSTEM,
    userPrompt: `Analyze this CRM CSV export and infer agent profile data:\n\n${truncated}`,
    responseFormat: CRM_ANALYSIS_FORMAT,
    taskType: "parsing",
    temperature: EXTRACTION_TEMPERATURE,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

  const data = result.parsed;
  const cleanArr = (v) => (Array.isArray(v) && v.length > 0 ? v.filter(Boolean) : undefined);
  const clean = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);

  return {
    sourceType: "crm_import",
    serviceAreas: cleanArr(data.serviceAreas),
    inferredPriceBands: cleanArr(data.inferredPriceBands),
    inferredAudience: cleanArr(data.inferredAudience),
    specialties: cleanArr(data.specialties),
    primaryCity: clean(data.primaryCity),
    primaryState: clean(data.primaryState),
    notes: cleanArr(data.notes),
    confidence: { serviceAreas: 0.6, inferredPriceBands: 0.5, inferredAudience: 0.5 },
  };
}

// ── Merge ────────────────────────────────────────────────────────────────

/**
 * Source priority order for string field resolution.
 * Higher priority sources win for non-empty string fields.
 */
const SOURCE_PRIORITY = ["manual", "license_lookup", "zillow_profile", "website", "crm_import", "documents"];

/**
 * Merge multiple AgentProfileDraft objects into one combined draft.
 * @param {AgentProfileDraft[]} drafts
 * @returns {AgentProfileDraft}
 */
export function mergeProfileDrafts(drafts) {
  if (!drafts || drafts.length === 0) return { sourceType: "manual" };
  if (drafts.length === 1) return { ...drafts[0] };

  // Sort drafts by source priority (highest priority first)
  const sorted = [...drafts].sort((a, b) => {
    const ai = SOURCE_PRIORITY.indexOf(a.sourceType);
    const bi = SOURCE_PRIORITY.indexOf(b.sourceType);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const STRING_FIELDS = [
    "agentName", "brokerageName", "teamName", "bio",
    "primaryCity", "primaryState", "licenseNumber", "licenseState",
    "licenseStatus", "websiteUrl", "zillowProfileUrl",
  ];

  const ARRAY_FIELDS = [
    "specialties", "serviceAreas", "exampleListings",
    "inferredAudience", "inferredPriceBands", "notes",
  ];

  const merged = { sourceType: "manual" };
  const mergedSources = {};

  // String fields: prefer first non-empty value (already sorted by priority)
  for (const field of STRING_FIELDS) {
    for (const draft of sorted) {
      if (draft[field] && String(draft[field]).trim()) {
        merged[field] = draft[field];
        mergedSources[field] = draft.sourceType;
        break;
      }
    }
  }

  // Array fields: union/deduplicate
  for (const field of ARRAY_FIELDS) {
    const all = [];
    const sources = [];
    for (const draft of sorted) {
      if (Array.isArray(draft[field]) && draft[field].length > 0) {
        all.push(...draft[field]);
        sources.push(draft.sourceType);
      }
    }
    if (all.length > 0) {
      // For object arrays (exampleListings), just concatenate
      if (field === "exampleListings") {
        merged[field] = all;
      } else {
        // Deduplicate strings (case-insensitive)
        const seen = new Set();
        merged[field] = all.filter((v) => {
          const key = String(v).toLowerCase().trim();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      mergedSources[field] = [...new Set(sources)].join(", ");
    }
  }

  // Social links: merge all
  const socialLinks = {};
  for (const draft of sorted) {
    if (draft.socialLinks) {
      for (const [k, v] of Object.entries(draft.socialLinks)) {
        if (v && !socialLinks[k]) socialLinks[k] = v;
      }
    }
  }
  if (Object.keys(socialLinks).length > 0) merged.socialLinks = socialLinks;

  // Confidence: merge and keep highest per field
  const confidence = {};
  for (const draft of drafts) {
    if (draft.confidence) {
      for (const [k, v] of Object.entries(draft.confidence)) {
        if (!confidence[k] || v > confidence[k]) confidence[k] = v;
      }
    }
  }
  if (Object.keys(confidence).length > 0) merged.confidence = confidence;

  merged._mergedSources = mergedSources;
  return merged;
}

// ── Draft to context text ───────────────────────────────────────────────

/**
 * Serialize a merged AgentProfileDraft into plaintext for injection into
 * the AI brand extraction prompt.
 * @param {AgentProfileDraft} draft
 * @returns {string}
 */
export function draftToContextText(draft) {
  if (!draft) return "";

  const lines = ["=== Pre-extracted Agent Profile Data ==="];

  if (draft.agentName) lines.push(`Agent Name: ${draft.agentName}`);
  if (draft.brokerageName) lines.push(`Brokerage: ${draft.brokerageName}`);
  if (draft.teamName) lines.push(`Team: ${draft.teamName}`);
  if (draft.bio) lines.push(`Bio: ${draft.bio}`);
  if (draft.primaryCity || draft.primaryState) {
    lines.push(`Primary Market: ${[draft.primaryCity, draft.primaryState].filter(Boolean).join(", ")}`);
  }
  if (draft.licenseNumber) {
    lines.push(`License: ${draft.licenseNumber} (${draft.licenseState || "N/A"}) — Status: ${draft.licenseStatus || "unknown"}`);
  }
  if (draft.specialties?.length) lines.push(`Specialties: ${draft.specialties.join(", ")}`);
  if (draft.serviceAreas?.length) lines.push(`Service Areas: ${draft.serviceAreas.join(", ")}`);
  if (draft.inferredAudience?.length) lines.push(`Target Audience: ${draft.inferredAudience.join(", ")}`);
  if (draft.inferredPriceBands?.length) lines.push(`Price Ranges: ${draft.inferredPriceBands.join(", ")}`);
  if (draft.websiteUrl) lines.push(`Website: ${draft.websiteUrl}`);
  if (draft.zillowProfileUrl) lines.push(`Zillow Profile: ${draft.zillowProfileUrl}`);

  if (draft.socialLinks) {
    const links = Object.entries(draft.socialLinks)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);
    if (links.length) lines.push(`Social Links: ${links.join(", ")}`);
  }

  if (draft.exampleListings?.length) {
    lines.push(`Recent Listings:`);
    for (const l of draft.exampleListings.slice(0, 5)) {
      const parts = [l.address, l.city, l.state].filter(Boolean).join(", ");
      lines.push(`  - ${parts}${l.price ? ` — $${l.price.toLocaleString()}` : ""}`);
    }
  }

  if (draft.notes?.length) {
    lines.push(`Notes: ${draft.notes.join("; ")}`);
  }

  lines.push("=== End Agent Profile Data ===");
  return lines.join("\n");
}
