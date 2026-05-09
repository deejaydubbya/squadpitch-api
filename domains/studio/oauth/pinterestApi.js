// Pinterest API host helper.
//
// Pinterest segregates Trial-access apps to the sandbox host —
// production api.pinterest.com refuses Pin creation with code 29:
//   "Apps with Trial access may not create Pins in production
//    https://api.pinterest.com - use API Sandbox
//    https://api-sandbox.pinterest.com instead."
//
// Setting PINTEREST_USE_SANDBOX=true switches every v5 call (token
// exchange, user account, boards listing, Pin creation) to the
// sandbox host so the publish flow works end to end while the app
// is still under Trial access. The OAuth consent UI itself stays
// on www.pinterest.com — Pinterest serves the same authorize page
// for sandbox and production apps.
//
// Read the env each call (rather than freezing at import time) so
// secret changes propagate without a restart, and so tests can
// override via vi.doMock without a fresh import for every assertion.

import { env } from "../../../config/env.js";

const PROD_BASE = "https://api.pinterest.com";
const SANDBOX_BASE = "https://api-sandbox.pinterest.com";

export function pinterestApiBase() {
  return env.PINTEREST_USE_SANDBOX ? SANDBOX_BASE : PROD_BASE;
}

export function pinterestApiUrl(path) {
  const base = pinterestApiBase();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
