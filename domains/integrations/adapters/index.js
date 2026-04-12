// Adapter registry — central map of integration type → adapter instance.
//
// To add a new integration type:
//   1. Create a new adapter extending BaseAdapter
//   2. Register it here

import { WebhookAdapter } from "./webhook.adapter.js";
import { SlackAdapter } from "./slack.adapter.js";
import { NotionAdapter } from "./notion.adapter.js";
import { SheetsAdapter } from "./sheets.adapter.js";
import { DiscordAdapter } from "./discord.adapter.js";
import { DriveAdapter } from "./drive.adapter.js";
import { DropboxAdapter } from "./dropbox.adapter.js";

const adapters = new Map();

const webhook = new WebhookAdapter();
const slack = new SlackAdapter();
const notion = new NotionAdapter();
const sheets = new SheetsAdapter();
const discord = new DiscordAdapter();
const drive = new DriveAdapter();
const dropbox = new DropboxAdapter();

adapters.set(webhook.name, webhook);
adapters.set(slack.name, slack);
adapters.set(notion.name, notion);
adapters.set(sheets.name, sheets);
adapters.set(discord.name, discord);
adapters.set(drive.name, drive);
adapters.set(dropbox.name, dropbox);

/**
 * Get all registered adapters.
 * @returns {Map<string, import("./base.adapter.js").BaseAdapter>}
 */
export function getAdapters() {
  return adapters;
}

/**
 * Get a specific adapter by type name.
 * @param {string} type
 * @returns {import("./base.adapter.js").BaseAdapter | undefined}
 */
export function getAdapter(type) {
  return adapters.get(type);
}

/**
 * Register a new adapter at runtime.
 * @param {import("./base.adapter.js").BaseAdapter} adapter
 */
export function registerAdapter(adapter) {
  adapters.set(adapter.name, adapter);
}
