// Server-side port of squadpitch-web/src/lib/assistant/draftSourceMeta.ts.
//
// Same tag format, same precedence. Used by the campaign backfill
// script to reconstruct source attribution for legacy Draft rows
// whose only source signal lives in `warnings: string[]`.
//
// Tag shape (written by studio.routes.js save-drafts):
//   source:property|data_item|idea
//   campaignType:<string>
//   campaignNameRoot:<string>
//   address:<string>            (property only)
//   sourceTitle:<string>        (optional)
//   sourceDataItemType:<string> (optional)
//   campaignIdea:<string>       (idea only)
//   dataItemId:<string>         (optional)
//   angle:<string>              (per-post; ignored here)

const EMPTY = {
  sourceType: null,
  sourceTitle: null,
  sourceDataItemType: null,
  campaignIdea: null,
  address: null,
  dataItemId: null,
  campaignNameRoot: null,
  campaignType: null,
  isAutopilot: false,
};

function readTag(warnings, key) {
  if (!Array.isArray(warnings)) return null;
  const prefix = `${key}:`;
  for (const w of warnings) {
    if (typeof w !== "string") continue;
    if (w.startsWith(prefix)) return w.slice(prefix.length).trim();
  }
  return null;
}

function normalizeSourceType(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v === "property" || v === "listing") return "property";
  if (v === "data_item" || v === "content_asset" || v === "asset") return "data_item";
  if (v === "idea" || v === "prompt") return "idea";
  return null;
}

export function parseDraftSourceMeta(warnings) {
  if (!warnings || !Array.isArray(warnings) || warnings.length === 0) {
    return { ...EMPTY };
  }
  const sourceType = normalizeSourceType(readTag(warnings, "source"));
  const sourceTitle = readTag(warnings, "sourceTitle");
  const sourceDataItemType = readTag(warnings, "sourceDataItemType");
  const campaignIdea = readTag(warnings, "campaignIdea");
  const address = readTag(warnings, "address");
  const dataItemId = readTag(warnings, "dataItemId");
  const campaignNameRoot = readTag(warnings, "campaignNameRoot");
  const campaignType = readTag(warnings, "campaignType");

  const isAutopilot = warnings.some(
    (w) =>
      typeof w === "string" &&
      (w === "autopilot: true" || w.startsWith("autopilot_"))
  );

  return {
    sourceType,
    sourceTitle,
    sourceDataItemType,
    campaignIdea,
    address,
    dataItemId,
    campaignNameRoot,
    campaignType,
    isAutopilot,
  };
}

/**
 * Pick the best human-readable title for a campaign-level source
 * cell, matching the web-side `sourceTitleForDisplay`.
 */
export function sourceTitleForDisplay(meta) {
  if (!meta) return null;
  if (meta.sourceType === "property") {
    return meta.address ?? meta.sourceTitle ?? meta.campaignNameRoot ?? null;
  }
  if (meta.sourceType === "data_item") {
    return meta.sourceTitle ?? meta.campaignNameRoot ?? null;
  }
  if (meta.sourceType === "idea") {
    return meta.campaignIdea ?? meta.campaignNameRoot ?? null;
  }
  return meta.campaignNameRoot ?? null;
}
