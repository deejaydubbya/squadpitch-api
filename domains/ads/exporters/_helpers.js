// Ads-04 — formatting helpers shared by renderers.
//
// CSV escaping follows RFC 4180 — wrap fields in quotes when they
// contain a comma / quote / newline, and double up embedded quotes.
// Google Ads Editor + TikTok Bulk Template both expect this.

export function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  // Always quote — strict, predictable, and the ad platform editors
  // accept fully-quoted fields. Defensive against future edits that
  // add a comma to a previously-comma-free field.
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(cells) {
  return cells.map(csvEscape).join(",");
}

export function slugifyForFilename(s) {
  return (
    String(s || "ad-package")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "ad-package"
  );
}

export function formatMoney(cents, currency = "USD") {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function describeSource(source) {
  if (!source) return "(unspecified)";
  if (source.kind === "IDEA") return source.text ? source.text.slice(0, 200) : "(idea)";
  if (source.name) return source.name;
  if (source.title) return source.title;
  return source.id ?? "(unknown)";
}

// Convert ad copy locations to a single human string suitable for a
// launch-sheet "Locations" cell. We do NOT split per-row because
// every platform wants its locations entered as a single targeting
// rule, not per ad.
export function joinLocations(locations) {
  if (!Array.isArray(locations) || locations.length === 0) return "";
  return locations.map((l) => `${l.value} (${l.kind})`).join("; ");
}

// Ads-10 — compact human-readable summary of an asset descriptor
// for launch-sheet rendering. Returns a short suffix like
// "(image · 1080×1350 · 240 KB)" or "" when nothing useful is set.
// Skips fields whose value is null so we don't render "null × null".
export function formatAssetMeta(asset) {
  if (!asset) return "";
  const parts = [];
  if (asset.assetType) parts.push(asset.assetType);
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (typeof asset.bytes === "number" && asset.bytes > 0) {
    parts.push(formatBytes(asset.bytes));
  }
  if (asset.videoDurationSec) parts.push(`${asset.videoDurationSec}s`);
  if (parts.length === 0 && asset.mimeType) parts.push(asset.mimeType);
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Truncate to `max` characters, appending an ellipsis when we cut.
// Caller decides what to do with the returned `truncated` flag —
// renderers usually push a warning into their warnings[] so the
// frontend can surface it instead of silently losing copy.
//
// The ellipsis counts toward `max`, so the truncated string always
// fits in the original budget (important for platforms that reject
// over-length fields with a generic error).
export function truncateWithEllipsis(value, max) {
  if (value == null) return { value: "", truncated: false };
  const s = String(value);
  if (s.length <= max) return { value: s, truncated: false };
  if (max <= 1) return { value: "…".slice(0, max), truncated: true };
  return { value: `${s.slice(0, max - 1).trimEnd()}…`, truncated: true };
}
