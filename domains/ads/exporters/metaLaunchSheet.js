// Meta (Facebook + Instagram) launch sheet — a CSV checklist your
// paid-media specialist works through inside Meta Ads Manager.
// NOT a direct import file — Meta does not accept arbitrary CSV
// imports. Future prompts may add a true Meta Ads Manager bulk
// import (XLSX) once we can guarantee account-specific IDs.

import { csvRow, formatMoney, joinLocations, slugifyForFilename } from "./_helpers.js";

export const metaLaunchSheet = {
  format: "meta_launch_sheet",
  aliases: [],
  label: "Meta Ads launch sheet (CSV)",
  mimeType: "text/csv; charset=utf-8",
  extension: "csv",
  platform: "meta",
  isDirectImport: false,
  notes: [
    "Setup checklist for Meta Ads Manager (Facebook + Instagram), not a",
    "bulk import file. Open in a spreadsheet and work through one row",
    "per variant inside Ads Manager.",
  ].join(" "),
  render(bundle, pkg) {
    const lines = [];
    // Header row — keep keys stable; downstream tools may grep these.
    lines.push(
      csvRow([
        "Variant",
        "Campaign objective",
        "Ad placement hint",
        "Headline",
        "Primary text",
        "Description",
        "CTA",
        "Destination URL",
        "Primary asset URL",
        "Additional asset URLs",
        "Locations",
        "Age range",
        "Genders",
        "Interests",
        "Daily budget",
        "Duration (days)",
        "Special category",
        "Notes",
      ]),
    );

    const audience = bundle.audience ?? null;
    const budget = bundle.budget ?? null;
    const destinationUrl = bundle.destination?.url ?? "";

    for (const c of bundle.creatives) {
      lines.push(
        csvRow([
          `Variant ${c.variantIndex}`,
          bundle.package.objective,
          c.channelHint ?? "",
          c.headline,
          c.primaryText,
          c.description ?? "",
          c.cta ?? "",
          destinationUrl,
          c.primaryAssetUrl ?? "",
          c.additionalAssetUrls.join("; "),
          joinLocations(audience?.locations),
          audience?.ageMin && audience?.ageMax
            ? `${audience.ageMin}-${audience.ageMax}`
            : "",
          (audience?.genders ?? ["all"]).join(", "),
          (audience?.interests ?? []).join("; "),
          budget?.dailyBudgetCents != null
            ? formatMoney(budget.dailyBudgetCents, budget.currency)
            : "",
          budget?.durationDays ?? "",
          bundle.package.specialCategory,
          c.rationale ?? "",
        ]),
      );
    }

    // Trailing setup notes — kept as comment-prefixed rows so a CSV
    // reader still parses cleanly but a human opening in Excel sees
    // the launch checklist directly.
    lines.push("");
    lines.push("# SETUP CHECKLIST");
    lines.push(
      "# 1. In Meta Ads Manager, create a new campaign matching the objective above.",
    );
    if (bundle.package.specialCategory === "HOUSING") {
      lines.push(
        "# 2. Mark the campaign as Special Ad Category = HOUSING before continuing.",
      );
    } else if (bundle.package.specialCategory !== "NONE") {
      lines.push(
        `# 2. Mark the campaign as Special Ad Category = ${bundle.package.specialCategory}.`,
      );
    }
    lines.push("# 3. Create one ad per variant row above (copy + asset + destination URL).");
    lines.push(
      "# 4. Apply your Meta Pixel + conversion event mapping at the ad-set level.",
    );
    lines.push(
      "# 5. Submit the campaign for Meta review. Squadpitch did not launch this.",
    );

    return {
      content: lines.join("\n"),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.meta-launch-sheet.csv`,
    };
  },
};
