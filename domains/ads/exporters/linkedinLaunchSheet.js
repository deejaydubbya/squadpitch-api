// LinkedIn Campaign Manager launch sheet. CSV checklist — not an
// import file. LinkedIn's bulk operations are Excel-template based
// and account-specific; we don't try to forge one.

import { csvRow, formatMoney, joinLocations, slugifyForFilename } from "./_helpers.js";

export const linkedinLaunchSheet = {
  format: "linkedin_launch_sheet",
  aliases: [],
  label: "LinkedIn launch sheet (CSV)",
  mimeType: "text/csv; charset=utf-8",
  extension: "csv",
  platform: "linkedin",
  isDirectImport: false,
  notes: [
    "Setup checklist for LinkedIn Campaign Manager. LinkedIn's true",
    "bulk-edit format is an account-specific Excel template; this CSV",
    "is for human review and one-by-one entry, not direct upload.",
  ].join(" "),
  render(bundle, pkg) {
    const lines = [];
    lines.push(
      csvRow([
        "Variant",
        "Campaign objective",
        "Format hint",
        "Headline",
        "Introductory text",
        "Description",
        "CTA",
        "Destination URL",
        "Primary asset URL",
        "Locations",
        "Industries / interests",
        "Languages",
        "Daily budget",
        "Duration (days)",
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
          c.channelHint ?? "LINKEDIN",
          c.headline,
          c.primaryText,
          c.description ?? "",
          c.cta ?? "",
          destinationUrl,
          c.primaryAssetUrl ?? "",
          joinLocations(audience?.locations),
          (audience?.interests ?? []).join("; "),
          (audience?.languages ?? []).join(", "),
          budget?.dailyBudgetCents != null
            ? formatMoney(budget.dailyBudgetCents, budget.currency)
            : "",
          budget?.durationDays ?? "",
          c.rationale ?? "",
        ]),
      );
    }

    lines.push("");
    lines.push("# SETUP CHECKLIST");
    lines.push(
      "# 1. In LinkedIn Campaign Manager, create a new campaign matching the objective above.",
    );
    lines.push(
      "# 2. For each variant row, create a Single Image / Document / Video ad as appropriate.",
    );
    lines.push(
      "# 3. Set targeting using the Locations + Industries/interests columns. LinkedIn does",
    );
    lines.push(
      "#    not support narrow demographic filters in some markets — review for compliance.",
    );
    lines.push(
      "# 4. Install LinkedIn Insight Tag on the destination if not already present.",
    );
    lines.push(
      "# 5. Submit for review. Squadpitch did not launch this.",
    );

    return {
      content: lines.join("\n"),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.linkedin-launch-sheet.csv`,
    };
  },
};
