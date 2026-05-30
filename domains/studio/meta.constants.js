// Shared Meta Graph API constants.
//
// Two distinct hosts, two distinct products:
//
//   META_GRAPH_BASE        → graph.facebook.com (Facebook Login,
//                            Page tokens, /me/accounts, Page-scoped
//                            endpoints). Used by Facebook adapter,
//                            Facebook OAuth, and Facebook App Review
//                            checks.
//
//   INSTAGRAM_GRAPH_BASE   → graph.instagram.com (Instagram API
//                            with Instagram Login / Business Login).
//                            Used by Instagram OAuth, refresh,
//                            validation, publishing, metrics, and
//                            Instagram App Review checks AFTER
//                            Prompt 01's migration.
//
// Keeping them separated means a Graph API version bump for one
// product doesn't accidentally drag the other.

export const META_GRAPH_VERSION = "v19.0";
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

// Instagram Login / Business Login surfaces don't carry a Graph
// version in the path — the host itself is the API. Tokens issued
// by the Instagram OAuth flow only authenticate against this host.
export const INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com";
