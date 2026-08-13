const CUSTOMER_VISIBLE_STATUSES = new Set(["DRAFT", "PENDING_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED"]);
const INTERNAL_DIAGNOSTIC_PREFIXES = ["PROSPECT_PROPERTY_FACT_GUARD:", "re_assets:"];

export function hasInternalDiagnosticBody(body) {
  return typeof body === "string" && INTERNAL_DIAGNOSTIC_PREFIXES.some((prefix) => body.includes(prefix));
}

export function customerVisibleWarnings(warnings) {
  return Array.isArray(warnings)
    ? warnings.filter((warning) => !INTERNAL_DIAGNOSTIC_PREFIXES.some((prefix) => warning.startsWith(prefix)))
    : [];
}

export function selectCanonicalProspectDrafts(previewItems, selectedChannels) {
  const selected = new Set(Array.isArray(selectedChannels) ? selectedChannels : []);
  const byChannel = new Map();
  for (const item of previewItems ?? []) {
    const draft = item?.draft;
    if (item?.itemType !== "DRAFT" || !draft || !selected.has(draft.channel)) continue;
    if (!CUSTOMER_VISIBLE_STATUSES.has(draft.status) || hasInternalDiagnosticBody(draft.body)) continue;
    const current = byChannel.get(draft.channel);
    if (!current || new Date(draft.createdAt).getTime() > new Date(current.draft.createdAt).getTime()) {
      byChannel.set(draft.channel, item);
    }
  }
  return [...byChannel.values()].sort((left, right) => left.sortOrder - right.sortOrder);
}

export const _internal = { CUSTOMER_VISIBLE_STATUSES, INTERNAL_DIAGNOSTIC_PREFIXES };
