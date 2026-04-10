// Shared Meta Graph API constants used by both the OAuth flow
// (domains/studio/oauth/instagram.oauth.js) and the Instagram
// publishing adapter (domains/studio/publishing/channelAdapters/
// instagram.adapter.js). Keeping the version number in one place means
// Graph API upgrades touch exactly one file.

export const META_GRAPH_VERSION = "v19.0";
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
