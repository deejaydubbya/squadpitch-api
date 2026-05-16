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
// everywhere. Phrasing per spinstr415.
export const ACCESS_DENIED_RESOLVER_REASON =
  "Awaiting Google Business Profile API access approval. Account and location connection works, but review sync requires Google allowlisting.";

export const ACCESS_DENIED_SETTINGS_BANNER =
  "Awaiting Google Business Profile API access approval. Account and location connection works, but review sync requires Google allowlisting.";

/**
 * True when a probe response (poller or reply send) looks like
 * Google saying "this project isn't allowlisted for the Business
 * Profile APIs yet." There are THREE different error shapes for
 * the same underlying gate, depending on which API surface you
 * hit:
 *
 *   1. Legacy reviews (mybusiness.googleapis.com v4):
 *      403 + "Permission denied" / "API has not been used"
 *   2. gcloud services enable mybusiness.googleapis.com:
 *      AUTH_PERMISSION_DENIED reason string
 *   3. v1 APIs (mybusinessaccountmanagement / mybusinessbusinessinformation):
 *      429 RESOURCE_EXHAUSTED + "Requests per minute exceeded"
 *      (sounds like a rate limit — but unapproveded projects have
 *      effectively a 0 RPM quota, so this error persists no matter
 *      how long you wait)
 *
 * All three resolve via the same Business Profile API approval +
 * quota-increase form, so we treat them as one marker state.
 */
export function isReviewApiAccessDenied(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? null;
  const message = String(err.message ?? err.gbpError?.error?.message ?? "");
  // (1) — 403 alone isn't enough; could be a scope problem on a
  // single location. Pair with explicit access-denied phrasing.
  if (status === 403 && /permission denied|not been used|disabled/i.test(message)) {
    return true;
  }
  // (3) — v1 API quota-zero state. 429 RESOURCE_EXHAUSTED with
  // "Requests per minute" phrasing. Persists regardless of timing
  // because unapproveded projects have RPM quota = 0.
  if (
    (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) &&
    /requests per minute|RESOURCE_EXHAUSTED|quota/i.test(message)
  ) {
    return true;
  }
  // (2) — serviceusage error from `gcloud services enable`. Same
  // gate, different surface.
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
