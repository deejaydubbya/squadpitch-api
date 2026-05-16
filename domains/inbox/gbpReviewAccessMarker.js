// Single source of truth for the "Google has not granted this
// project access to the Business Profile reviews API yet" marker.
//
// We stash this state in ChannelConnection.lastError using a
// stable prefix so:
//   - the poller can write it without a schema migration,
//   - the capability resolver can detect it without joining
//     a separate table,
//   - the UI can render an approval-pending banner that links
//     out to Google's access form.
//
// Reviews live on the legacy mybusiness.googleapis.com (v4)
// API, which Google removed from public availability in 2024.
// Until they approve a project via the Business Profile API
// Access form, reviews.list AND reviews.updateReply return
// 403 PERMISSION_DENIED. The newer v1 APIs (Account Management
// + Business Information) still work, so OAuth + location
// picker keep functioning — only the actual review surfaces
// are gated.

export const REVIEW_API_ACCESS_DENIED_PREFIX = "REVIEW_API_ACCESS_DENIED:";

export const ACCESS_REQUEST_FORM_URL =
  "https://developers.google.com/my-business/content/prereqs";

// User-facing copy shown in the resolver's REPLY_REVIEW reason +
// the Settings tile banner. Kept here so the wording stays
// consistent across surfaces — change it once, change it
// everywhere.
export const ACCESS_DENIED_RESOLVER_REASON =
  "Google has not yet approved this project for the Business Profile reviews API. Reviews can't be polled or replied to until approval lands.";

export const ACCESS_DENIED_SETTINGS_BANNER =
  "Google hasn't granted this project access to the Business Profile reviews API yet. OAuth and location selection work, but review polling and public replies are blocked until approval lands.";

/**
 * True when a probe response (poller or reply send) looks like
 * Google saying "this project isn't allowlisted for the reviews
 * API." Matches both the gcloud-style PERMISSION_DENIED string
 * and the HTTP 403 status — Google returns both shapes depending
 * on the call site.
 */
export function isReviewApiAccessDenied(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? null;
  const message = String(err.message ?? err.gbpError?.error?.message ?? "");
  // 403 alone isn't enough — could be a scope problem on a single
  // location. Pair with the explicit access-denied phrasing
  // Google uses on legacy GMB endpoints.
  if (status === 403 && /permission denied|not been used|disabled/i.test(message)) {
    return true;
  }
  // The serviceusage error from `gcloud services enable` uses a
  // slightly different shape — we don't see that one in the
  // outbound path, but cover it for tests.
  if (/AUTH_PERMISSION_DENIED|PERMISSION_DENIED/i.test(message)) {
    return true;
  }
  return false;
}

/**
 * Build the marker string stored on ChannelConnection.lastError.
 * Includes a (brief) provider message so ops can distinguish a
 * sustained block from a transient one without leaving the DB.
 */
export function buildAccessDeniedMarker(providerMessage) {
  const trimmed =
    typeof providerMessage === "string"
      ? providerMessage.replace(/\s+/g, " ").slice(0, 240)
      : "Google denied access to mybusiness.googleapis.com";
  return `${REVIEW_API_ACCESS_DENIED_PREFIX} ${trimmed}`;
}

/**
 * True when a stored ChannelConnection.lastError carries the
 * access-denied marker. Used by the resolver + the UI.
 */
export function isAccessDeniedMarker(lastError) {
  return (
    typeof lastError === "string" &&
    lastError.startsWith(REVIEW_API_ACCESS_DENIED_PREFIX)
  );
}
