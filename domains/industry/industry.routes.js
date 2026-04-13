// Industry routes — public-facing industry profile endpoints.

import { Router } from "express";
import { listIndustryProfiles, getIndustryProfile } from "./registry.js";
import { sendError } from "../../lib/apiErrors.js";

export const industryRouter = Router();

const BASE = "/api/v1";

/**
 * GET /api/v1/industries
 * Returns all industry profiles (without extraction hints — those are internal).
 */
industryRouter.get(`${BASE}/industries`, (_req, res) => {
  const profiles = listIndustryProfiles().map(formatProfilePublic);
  res.json({ industries: profiles });
});

/**
 * GET /api/v1/industries/:key
 * Returns a single industry profile by key.
 */
industryRouter.get(`${BASE}/industries/:key`, (req, res) => {
  const profile = getIndustryProfile(req.params.key);
  if (!profile) {
    return sendError(res, 404, "INDUSTRY_NOT_FOUND", `Unknown industry key: ${req.params.key}`);
  }
  res.json(formatProfilePublic(profile));
});

/**
 * Strip extraction hints from public response — those are internal to AI prompts.
 */
function formatProfilePublic(profile) {
  return {
    key: profile.key,
    label: profile.label,
    description: profile.description,
    onboarding: profile.onboarding,
    content: {
      starterBlueprintSlugs: profile.content.starterBlueprintSlugs,
      starterChannels: profile.content.starterChannels,
      // starterAngles omitted — sent via SSE done event, not static endpoint
    },
    integrations: profile.integrations,
    ui: profile.ui,
  };
}
