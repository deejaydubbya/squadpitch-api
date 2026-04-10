// Channel adapter registry for publishing.
//
// Mirrors domains/aiPersona/publishing/channelAdapters/index.js — same
// folder name so greps line up. Adding a new channel: import the adapter
// module and register it here.

import { instagramAdapter } from "./instagram.adapter.js";
import { facebookAdapter } from "./facebook.adapter.js";
import { tiktokAdapter } from "./tiktok.adapter.js";
import { linkedinAdapter } from "./linkedin.adapter.js";
import { xAdapter } from "./x.adapter.js";

const ADAPTERS = {
  INSTAGRAM: instagramAdapter,
  FACEBOOK: facebookAdapter,
  TIKTOK: tiktokAdapter,
  LINKEDIN: linkedinAdapter,
  X: xAdapter,
};

export function getAdapterForChannel(channel) {
  const adapter = ADAPTERS[channel];
  if (!adapter) {
    throw Object.assign(
      new Error(`No adapter registered for channel ${channel}`),
      { status: 400, code: "UNKNOWN_CHANNEL" }
    );
  }
  return adapter;
}
