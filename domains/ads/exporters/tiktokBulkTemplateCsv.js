// TikTok Ads Bulk Template — baseline CSV scaffold.
//
// TikTok's official bulk-edit template is an XLSX with strict
// column ordering. Squadpitch doesn't have XLSX deps wired in yet,
// so this prompt ships a CSV with the equivalent column set that
// the user can paste into TikTok's template. ads-06 will extend
// coverage and (if XLSX support lands) emit a true bulk template.

import { csvRow, formatMoney, joinLocations, slugifyForFilename } from "./_helpers.js";

export const tiktokBulkTemplateCsv = {
  format: "tiktok_bulk_template_csv",
  aliases: [],
  label: "TikTok Ads bulk template (CSV)",
  mimeType: "text/csv; charset=utf-8",
  extension: "csv",
  platform: "tiktok",
  isDirectImport: true,
  notes: [
    "Baseline rows matching TikTok Ads Manager's bulk template columns.",
    "TikTok's official template is XLSX; paste these cells into the",
    "template downloaded from your Ads Manager and validate before",
    "uploading. ads-06 will improve field coverage.",
  ].join(" "),
  render(bundle, pkg) {
    const lines = [];
    lines.push(
      csvRow([
        "Campaign name",
        "Ad group name",
        "Ad name",
        "Objective",
        "Ad text",
        "Display name",
        "CTA",
        "Landing page URL",
        "Video / image asset URL",
        "Locations",
        "Age range",
        "Genders",
        "Interests",
        "Daily budget",
        "Schedule (days)",
        "Notes",
      ]),
    );

    const campaignName = bundle.package.name.slice(0, 120);
    const adGroupName = `${campaignName} — group`;
    const audience = bundle.audience ?? null;
    const budget = bundle.budget ?? null;
    const destinationUrl = bundle.destination?.url ?? "";

    for (const c of bundle.creatives) {
      lines.push(
        csvRow([
          campaignName,
          adGroupName,
          `Variant ${c.variantIndex}`,
          bundle.package.objective,
          c.primaryText,
          c.headline,
          c.cta ?? "",
          destinationUrl,
          c.primaryAssetUrl ?? "",
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
          c.rationale ?? "",
        ]),
      );
    }

    lines.push("");
    lines.push("# SETUP CHECKLIST");
    lines.push(
      "# 1. Open TikTok Ads Manager → Tools → Bulk export, and download the latest template.",
    );
    lines.push(
      "# 2. Paste the rows above into the matching columns of TikTok's XLSX template.",
    );
    lines.push(
      "# 3. Upload the asset files (videos / images) to TikTok's asset library first;",
    );
    lines.push(
      "#    replace 'Video / image asset URL' values with TikTok asset IDs in the template.",
    );
    lines.push(
      "# 4. Validate inside TikTok Ads Manager before submitting.",
    );

    return {
      content: lines.join("\n"),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.tiktok-bulk.csv`,
    };
  },
};
