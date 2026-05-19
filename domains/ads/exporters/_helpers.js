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
