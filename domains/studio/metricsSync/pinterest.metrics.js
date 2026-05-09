// Pinterest metrics adapter — STUB.
//
// Pinterest analytics requires the user_accounts:read + (paid-tier
// or admin-approved) "pin_analytics" / "user_account_analytics"
// scopes plus app review for the analytics product. Squadpitch does
// not request those scopes today (per spinstr367, scope set is
// minimal: user_accounts:read, boards:read, pins:read, pins:write).
//
// Returning null here is the documented "provider has no metrics"
// signal — metricsSyncService maps that to reason: "provider_no_metrics"
// for the row, no retry, no silent failure.
//
// To enable Pinterest analytics later:
//   1. Update domains/studio/oauth/pinterest.oauth.js scopes.
//   2. Re-OAuth all existing Pinterest connections.
//   3. Replace this stub with a real /v5/pin_analytics fetch.

export async function fetchPinterestMetrics(/* { connection, externalPostId } */) {
  return null;
}
