// OAuth module registry.
//
// Maps each channel to its { buildAuthUrl, exchangeCode } implementation.
// Routes dispatch via getOAuthForChannel() instead of hardcoding per-channel
// logic, so adding a new platform is just "add module + register here".

import * as instagram from "./instagram.oauth.js";
import * as facebook from "./facebook.oauth.js";
import * as tiktok from "./tiktok.oauth.js";
import * as linkedin from "./linkedin.oauth.js";
import * as x from "./x.oauth.js";

const OAUTH_MODULES = {
  INSTAGRAM: instagram,
  FACEBOOK: facebook,
  TIKTOK: tiktok,
  LINKEDIN: linkedin,
  X: x,
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
