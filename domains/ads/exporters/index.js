// Ads-04 — exporter registry.
//
// Maps a format slug → renderer descriptor. Each renderer takes a
// canonical bundle (built by ./bundle.js) and returns { content,
// filename }. The descriptor's mimeType / extension / label /
// platform / isDirectImport / notes flow back to the caller so the
// frontend can render an honest UI without hard-coded per-format
// branching.
//
// To add a new platform exporter:
//   1. Drop a new file in this directory exporting a descriptor.
//   2. Add it to ALL_EXPORTERS below.
//   3. (Optional) add a one-test-per-format MIME/extension check.
// The service layer + route + schema all read from this registry.

import { squadadsJson } from "./squadadsJson.js";
import { agencyMarkdown } from "./agencyMarkdown.js";
import { metaLaunchSheet } from "./metaLaunchSheet.js";
import { linkedinLaunchSheet } from "./linkedinLaunchSheet.js";
import { pinterestLaunchSheet } from "./pinterestLaunchSheet.js";
import { googleAdsEditorCsv } from "./googleAdsEditorCsv.js";
import { tiktokBulkTemplateCsv } from "./tiktokBulkTemplateCsv.js";

const ALL_EXPORTERS = [
  squadadsJson,
  agencyMarkdown,
  metaLaunchSheet,
  linkedinLaunchSheet,
  pinterestLaunchSheet,
  googleAdsEditorCsv,
  tiktokBulkTemplateCsv,
];

// Build a lookup that resolves both canonical formats and their
// legacy aliases ('json' → squadads_json, 'markdown' → agency_markdown).
const BY_FORMAT = new Map();
for (const exporter of ALL_EXPORTERS) {
  BY_FORMAT.set(exporter.format, exporter);
  for (const alias of exporter.aliases ?? []) {
    if (BY_FORMAT.has(alias)) {
      throw new Error(
        `Ads exporter alias collision: '${alias}' is registered to multiple formats`,
      );
    }
    BY_FORMAT.set(alias, exporter);
  }
}

export function getExporter(format) {
  return BY_FORMAT.get(format) ?? null;
}

// Sorted list of canonical format names + aliases, for the schema's
// z.enum() input. Sorted so the generated schema is stable across
// rebuilds.
export const SUPPORTED_FORMATS = [
  ...new Set(
    ALL_EXPORTERS.flatMap((e) => [e.format, ...(e.aliases ?? [])]),
  ),
].sort();

// Public surface for the frontend "format chooser" UI (ads-09).
// Strips the render() function — only metadata. Aliases are folded
// into a single entry per canonical exporter.
export function listExporters() {
  return ALL_EXPORTERS.map((e) => ({
    format: e.format,
    aliases: e.aliases ?? [],
    label: e.label,
    mimeType: e.mimeType,
    extension: e.extension,
    platform: e.platform,
    isDirectImport: e.isDirectImport,
    importStyle: e.importStyle ?? null,
    // Ads-06 — true for renderers that need the user to download a
    // platform-specific template before importing (TikTok bulk
    // edit). The FE renders an honest "paste these into TikTok's
    // template" hint instead of "one-click import".
    requiresPlatformTemplateReview: e.requiresPlatformTemplateReview ?? false,
    notes: e.notes,
  }));
}
