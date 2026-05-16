// OAuth module registry.
//
// Maps each channel to its { buildAuthUrl, exchangeCode } implementation.
// Routes dispatch via getOAuthForChannel() instead of hardcoding per-channel
// logic, so adding a new platform is just "add module + register here".

import * as instagram from "./instagram.oauth.js";
import * as facebook from "./facebook.oauth.js";
import * as tiktok from "./tiktok.oauth.js";
import * as linkedin from "./linkedin.oauth.js";
import * as linkedinOrg from "./linkedinOrg.oauth.js";
import * as pinterest from "./pinterest.oauth.js";
import * as x from "./x.oauth.js";
import * as youtube from "./youtube.oauth.js";
import * as threads from "./threads.oauth.js";
import * as googleBusinessProfile from "./googleBusinessProfile.oauth.js";

const OAUTH_MODULES = {
  INSTAGRAM: instagram,
  FACEBOOK: facebook,
  TIKTOK: tiktok,
  LINKEDIN: linkedin,
  LINKEDIN_ORGANIZATION_PAGE: linkedinOrg,
  PINTEREST: pinterest,
  X: x,
  YOUTUBE: youtube,
  THREADS: threads,
  GOOGLE_BUSINESS_PROFILE: googleBusinessProfile,
};

/**
 * Returns { buildAuthUrl, exchangeCode } for the given channel.
 * Throws 501 if the channel has no OAuth module registered.
 */
export function getOAuthForChannel(channel) {
  const mod = OAUTH_MODULES[channel];
  if (!mod) {
    throw Object.assign(
      new Error(`OAuth for ${channel} is not yet implemented`),
      { status: 501, code: "ADAPTER_NOT_IMPLEMENTED" }
    );
  }
  return mod;
}
