// Google Ads Editor CSV — baseline scaffold.
//
// Google Ads Editor *does* accept CSV import for Responsive Search
// Ads (RSA), but it is column-order sensitive and requires
// account-specific Campaign/Ad-group names that already exist in the
// account. This baseline emits the canonical RSA column set with the
// data we have, plus a SETUP CHECKLIST so a paid-media specialist
// can prep the account before importing.
//
// Future prompt (ads-05) will deepen the field coverage and add per-
// objective campaign settings rows.

import { csvRow, formatMoney, slugifyForFilename } from "./_helpers.js";

export const googleAdsEditorCsv = {
  format: "google_ads_editor_csv",
  aliases: [],
  label: "Google Ads Editor CSV (baseline)",
  mimeType: "text/csv; charset=utf-8",
  extension: "csv",
  platform: "google",
  isDirectImport: true,
  notes: [
    "Baseline Responsive Search Ad rows for Google Ads Editor import.",
    "You MUST already have a Campaign + Ad group with the names below",
    "in your account, and you should validate the result inside Editor",
    "before posting to Google Ads. ads-05 will deepen field coverage.",
  ].join(" "),
  render(bundle, pkg) {
    const lines = [];
    // Google Ads Editor RSA import columns (subset). Full schema is
    // long; this baseline carries the ones we can populate from a
    // SquadAds package. Account team can fill the rest in Editor.
    lines.push(
      csvRow([
        "Campaign",
        "Ad group",
        "Ad type",
        "Headline 1",
        "Headline 2",
        "Headline 3",
        "Description 1",
        "Description 2",
        "Final URL",
        "Path 1",
        "Path 2",
      ]),
    );

    const campaignName = bundle.package.name.slice(0, 120);
    const adGroupName = `${campaignName} — variants`;
    const destinationUrl = bundle.destination?.url ?? "";

    for (const c of bundle.creatives) {
      // Google RSAs accept up to 15 headlines + 4 descriptions. We
      // map the SquadAds variant 1:1 — headline → Headline 1,
      // headline (truncated) → Headline 2 etc — leaving the rest
      // for the account team to add in Editor.
      const h1 = c.headline.slice(0, 30);
      const h2 = c.description ? c.description.slice(0, 30) : c.cta ?? "";
      const h3 = c.cta ?? "";
      const d1 = c.primaryText.slice(0, 90);
      const d2 = c.rationale ? c.rationale.slice(0, 90) : "";

      lines.push(
        csvRow([
          campaignName,
          adGroupName,
          "Responsive search ad",
          h1,
          h2,
          h3,
          d1,
          d2,
          destinationUrl,
          "",
          "",
        ]),
      );
    }

    const budget = bundle.budget ?? null;
    lines.push("");
    lines.push("# SETUP CHECKLIST");
    lines.push(
      "# 1. In Google Ads Editor, create or open a Campaign named exactly:",
    );
    lines.push(`#      ${campaignName}`);
    lines.push("# 2. Inside it, create an Ad group named exactly:");
    lines.push(`#      ${adGroupName}`);
    if (budget?.dailyBudgetCents != null) {
      lines.push(
        `# 3. Set the campaign daily budget to ${formatMoney(budget.dailyBudgetCents, budget.currency)}.`,
      );
    }
    lines.push(
      "# 4. Apply locations + audience targeting from the agency_markdown export.",
    );
    lines.push("# 5. Import this CSV in Editor and validate before posting to Google Ads.");
    if (bundle.package.specialCategory === "HOUSING") {
      lines.push(
        "# 6. Mark the campaign with the Housing restricted-targeting policy.",
      );
    }

    return {
      content: lines.join("\n"),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.google-ads-editor.csv`,
    };
  },
};
