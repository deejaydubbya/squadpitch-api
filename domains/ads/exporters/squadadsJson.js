// Internal canonical developer export. Pretty-printed JSON of the
// canonical bundle, byte-for-byte compatible with the pre-ads-04
// `format=json` export so existing integrations keep working.

import { slugifyForFilename } from "./_helpers.js";

export const squadadsJson = {
  format: "squadads_json",
  aliases: ["json"],
  label: "SquadAds JSON (canonical)",
  mimeType: "application/json",
  extension: "json",
  platform: "squadpitch",
  isDirectImport: false,
  notes: [
    "Internal canonical bundle. Suitable for programmatic ingestion by",
    "future tooling or a paid-media agency. Not directly importable into",
    "any ad platform on its own.",
  ].join(" "),
  render(bundle, pkg) {
    return {
      content: JSON.stringify(bundle, null, 2),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.json`,
    };
  },
};
