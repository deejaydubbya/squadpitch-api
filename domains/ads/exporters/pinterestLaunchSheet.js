// Pinterest Ads launch sheet. CSV checklist for Pinterest Ads
// Manager. Pinterest's bulk-edit format is account/template
// specific; this CSV is for review + one-by-one entry.

import { csvRow, formatMoney, joinLocations, slugifyForFilename } from "./_helpers.js";

export const pinterestLaunchSheet = {
  format: "pinterest_launch_sheet",
  aliases: [],
  label: "Pinterest launch sheet (CSV)",
  mimeType: "text/csv; charset=utf-8",
  extension: "csv",
  platform: "pinterest",
  isDirectImport: false,
  notes: [
    "Setup checklist for Pinterest Ads Manager. Pin formats vary; this",
    "sheet covers Standard Pin / Video Pin / Idea Pin variants. Not a",
    "direct upload file — Pinterest bulk-edit uses an Excel template.",
  ].join(" "),
  render(bundle, pkg) {
    const lines = [];
    lines.push(
      csvRow([
        "Variant",
        "Campaign objective",
        "Pin format hint",
        "Title (headline)",
        "Description (primary text)",
        "Destination URL",
        "Image / video asset URL",
        "Locations",
        "Interests / keywords",
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
          c.channelHint ?? "PINTEREST",
          c.headline,
          c.primaryText,
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
      "# 1. In Pinterest Ads Manager, create a new campaign matching the objective above.",
    );
    lines.push(
      "# 2. Create one ad group per audience segment; one Pin per variant row above.",
    );
    lines.push(
      "# 3. Upload the image/video assets manually — Pinterest requires the actual file,",
    );
    lines.push(
      "#    the URL above is for reference only.",
    );
    lines.push("# 4. Apply your Pinterest Tag at the destination if not already present.");
    lines.push(
      "# 5. Submit for Pinterest review. Squadpitch did not launch this.",
    );

    return {
      content: lines.join("\n"),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.pinterest-launch-sheet.csv`,
    };
  },
};
