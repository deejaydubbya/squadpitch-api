// Ads-05 — Google Ads Editor CSV export.
//
// Emits a clean, comment-free CSV that's structured the way Google
// Ads Editor expects a starter template:
//   1. one Campaign row (objective, budget, networks, status)
//   2. one Ad group row
//   3. N Ad rows (one per SquadAds creative variant)
//
// Field length is bounded to Google's RSA limits. When a SquadAds
// field exceeds a limit we truncate with an ellipsis AND return a
// machine-readable warning in the export response so the FE can
// flag the variant — silent truncation would let bad copy ship.
//
// Honest positioning: this is a starter import, NOT a guaranteed
// one-click launch. Campaign type / bidding / device targeting /
// account-specific settings still need user review inside Editor
// before Post. The descriptor sets `isDirectImport: false` and
// `importStyle: 'google_ads_editor_csv'` so the FE renders the
// honest "starter file" framing.

import { csvRow, formatMoney, slugifyForFilename, truncateWithEllipsis } from "./_helpers.js";

// Google Ads Editor RSA field limits.
const LIMITS = {
  HEADLINE: 30,
  DESCRIPTION: 90,
  PATH: 15,
  FINAL_URL: 2048,
  CAMPAIGN_NAME: 255,
  AD_GROUP_NAME: 255,
};

// Conservative baseline: Search is the most common starting point
// for the objectives SquadAds emits. The user can change to
// Display / Performance Max / Video inside Editor before posting.
const CAMPAIGN_TYPE_DEFAULT = "Search";

// SquadAds dollar→cents to Google's "Budget" decimal column. We
// emit the bare number (e.g. "50.00") so Editor can ingest it
// without locale parsing; the "Budget type" column gets "Daily".
function budgetCells(budget) {
  if (!budget || budget.dailyBudgetCents == null) {
    return { amount: "", type: "", currencyNote: "" };
  }
  const dollars = (budget.dailyBudgetCents / 100).toFixed(2);
  return {
    amount: dollars,
    type: "Daily",
    currencyNote: `Currency: ${budget.currency || "USD"}`,
  };
}

const COLUMNS = [
  "Campaign",
  "Campaign type",
  "Campaign status",
  "Budget",
  "Budget type",
  "Networks",
  "Ad group",
  "Ad group status",
  "Headline 1",
  "Headline 2",
  "Headline 3",
  "Description 1",
  "Description 2",
  "Final URL",
  "Path 1",
  "Path 2",
  "Labels",
  "Custom parameter",
  "Notes",
];

function emptyRow() {
  return COLUMNS.map(() => "");
}

function setCell(row, column, value) {
  row[COLUMNS.indexOf(column)] = value ?? "";
}

export const googleAdsEditorCsv = {
  format: "google_ads_editor_csv",
  aliases: [],
  label: "Google Ads Editor CSV",
  mimeType: "text/csv; charset=utf-8",
  extension: "csv",
  platform: "google",
  // Honest: this is a starter file. Even though Editor will *try*
  // to import it, campaign-type / bidding / conversion-tracking
  // settings still need user attention. The FE renders this as
  // "starter CSV", not "one-click import".
  isDirectImport: false,
  importStyle: "google_ads_editor_csv",
  notes: [
    "Starter import file for Google Ads Editor (Search RSA baseline).",
    "Open in Editor, review the campaign type / bidding strategy /",
    "device + location targeting / conversion tracking, then Post to",
    "Google Ads. Field-length warnings (if any) appear in the export",
    "response alongside this file.",
  ].join(" "),
  render(bundle, pkg) {
    const warnings = [];

    // Sanitize names. Google Ads will accept up to 255 chars but
    // shorter is friendlier in Editor's grid view.
    const campaignName = truncateWithEllipsis(
      bundle.package.name,
      LIMITS.CAMPAIGN_NAME,
    ).value;
    const adGroupName = truncateWithEllipsis(
      `${bundle.package.name} — variants`,
      LIMITS.AD_GROUP_NAME,
    ).value;

    const { amount, type, currencyNote } = budgetCells(bundle.budget);
    const destinationUrl = bundle.destination?.url ?? "";
    if (destinationUrl && destinationUrl.length > LIMITS.FINAL_URL) {
      warnings.push({
        code: "FIELD_TOO_LONG",
        field: "Final URL",
        limit: LIMITS.FINAL_URL,
        variantIndex: null,
        message: `Resolved destination URL exceeds Google's ${LIMITS.FINAL_URL}-char Final URL limit.`,
      });
    }

    // Housing copy lives in the Notes column on every ad row so the
    // user sees it in Editor's grid view. Compliance-side validation
    // already cleared demographic targeting upstream (ads-02), but
    // Google still flags housing creatives during ad review.
    const housingNote =
      bundle.package.specialCategory === "HOUSING"
        ? "Housing ad — Google enforces restricted targeting + ad review. Confirm location targeting is ≥15-mile radius and no protected-class copy."
        : bundle.package.specialCategory !== "NONE"
        ? `Special category: ${bundle.package.specialCategory} — review Google's restricted ad policies before posting.`
        : "";

    const rows = [csvRow(COLUMNS)];

    // ── Campaign row ────────────────────────────────────────────
    const campaignRow = emptyRow();
    setCell(campaignRow, "Campaign", campaignName);
    setCell(campaignRow, "Campaign type", CAMPAIGN_TYPE_DEFAULT);
    setCell(campaignRow, "Campaign status", "Paused"); // never auto-Enabled
    setCell(campaignRow, "Budget", amount);
    setCell(campaignRow, "Budget type", type);
    setCell(campaignRow, "Networks", "Google search");
    setCell(
      campaignRow,
      "Notes",
      [
        currencyNote,
        `Objective hint: ${bundle.package.objective} (campaign type defaults to ${CAMPAIGN_TYPE_DEFAULT}; change in Editor if needed).`,
        housingNote,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    rows.push(csvRow(campaignRow));

    // ── Ad group row ────────────────────────────────────────────
    const adGroupRow = emptyRow();
    setCell(adGroupRow, "Campaign", campaignName);
    setCell(adGroupRow, "Ad group", adGroupName);
    setCell(adGroupRow, "Ad group status", "Paused");
    rows.push(csvRow(adGroupRow));

    // ── One Ad row per SquadAds creative variant ────────────────
    for (const c of bundle.creatives) {
      const h1 = clipWithWarn(c.headline, LIMITS.HEADLINE, c.variantIndex, "Headline 1", warnings);
      // h2 / h3 reuse the SquadAds shape: description or CTA
      // promote into headlines. These are still required by
      // Google RSA (3 headlines minimum), so we always emit
      // something even if it duplicates other fields — the
      // account team can revise inside Editor.
      const h2 = clipWithWarn(c.description ?? c.cta ?? c.headline, LIMITS.HEADLINE, c.variantIndex, "Headline 2", warnings);
      const h3 = clipWithWarn(c.cta ?? c.headline, LIMITS.HEADLINE, c.variantIndex, "Headline 3", warnings);

      const d1 = clipWithWarn(c.primaryText, LIMITS.DESCRIPTION, c.variantIndex, "Description 1", warnings);
      const d2 = clipWithWarn(c.rationale ?? "", LIMITS.DESCRIPTION, c.variantIndex, "Description 2", warnings);

      const adRow = emptyRow();
      setCell(adRow, "Campaign", campaignName);
      setCell(adRow, "Ad group", adGroupName);
      setCell(adRow, "Headline 1", h1);
      setCell(adRow, "Headline 2", h2);
      setCell(adRow, "Headline 3", h3);
      setCell(adRow, "Description 1", d1);
      setCell(adRow, "Description 2", d2);
      setCell(adRow, "Final URL", destinationUrl);
      // Path 1 / Path 2 are display URL slugs (max 15 chars each).
      // Auto-derive from objective so the user has *something*
      // visible — they'll usually customize these inside Editor.
      setCell(
        adRow,
        "Path 1",
        truncateWithEllipsis(bundle.package.objective.toLowerCase(), LIMITS.PATH).value,
      );
      setCell(adRow, "Path 2", "");
      // Labels: SquadAds package id (short) so the team can group
      // ads in Editor by SquadAds package after import.
      setCell(adRow, "Labels", `SquadAds:${pkg.id.slice(-6)}`);
      // Custom parameter: lets the user thread their own value
      // (e.g. listing id) without us prescribing one.
      setCell(adRow, "Custom parameter", "");
      setCell(
        adRow,
        "Notes",
        [
          c.rationale ? `Rationale: ${c.rationale}` : "",
          housingNote,
        ]
          .filter(Boolean)
          .join(" | "),
      );
      rows.push(csvRow(adRow));
    }

    const content = rows.join("\n");

    return {
      content,
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.google-ads-editor.csv`,
      warnings,
    };
  },
};

function clipWithWarn(value, limit, variantIndex, field, warnings) {
  const { value: trimmed, truncated } = truncateWithEllipsis(value, limit);
  if (truncated) {
    warnings.push({
      code: "FIELD_TRUNCATED",
      field,
      limit,
      variantIndex,
      message: `Variant ${variantIndex} ${field} was truncated to fit Google's ${limit}-char limit.`,
    });
  }
  return trimmed;
}
