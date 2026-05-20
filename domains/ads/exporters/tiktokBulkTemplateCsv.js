// Ads-06 — TikTok Ads bulk-template worksheet.
//
// Emits a CSV that mirrors TikTok Ads Manager's bulk setup fields.
// TikTok's true bulk-edit upload format is an account-specific XLSX
// template downloaded from inside Ads Manager — there's no universal
// CSV import. So this exporter is intentionally framed as a
// "worksheet to accelerate manual or bulk setup", not an import file.
//
// Renderer descriptor sets `isDirectImport: false` and a custom
// `requiresPlatformTemplateReview: true` flag so the FE can render
// the honest "download TikTok's template from Ads Manager and paste
// these rows in" framing instead of a deceptive "one-click import".
//
// Field-length warnings (machine-readable) follow the same shape as
// the Google CSV exporter — silent truncation is never acceptable.

import { csvRow, formatMoney, joinLocations, slugifyForFilename, truncateWithEllipsis } from "./_helpers.js";

// TikTok field limits (current as of 2026; conservative end of
// historical ranges so older templates still accept). If TikTok
// tightens a limit, the warnings will surface it.
const LIMITS = {
  CAMPAIGN_NAME: 512,
  AD_GROUP_NAME: 512,
  AD_NAME: 512,
  AD_TEXT: 100,
  DISPLAY_NAME: 40,
  LANDING_URL: 2048,
};

const COLUMNS = [
  "Campaign Name",
  "Campaign Objective",
  "Campaign Budget Type",
  "Campaign Budget",
  "Ad Group Name",
  "Placements",
  "Location Targeting",
  "Age Targeting",
  "Gender Targeting",
  "Interest Targeting",
  "Optimization Goal",
  "Bid Strategy",
  "Ad Name",
  "Ad Text",
  "Call To Action",
  "Landing Page URL",
  "Asset URL",
  "Compliance Notes",
  "Manual Setup Notes",
];

// Map SquadAds objective → TikTok-style objective. Where TikTok has
// two reasonable targets for one SquadAds objective we pick a
// sensible default AND emit a per-row note telling the user to
// confirm. Never silently pick a conversion-style objective without
// flagging it — those have account-level setup prerequisites the
// SquadAds bundle doesn't cover.
const OBJECTIVE_MAP = {
  TRAFFIC: { tiktok: "Traffic", confirmNote: null },
  LEADS: {
    tiktok: "Lead Generation",
    // SITE_PAGE destinations could also use Website Conversions if
    // the user has the TikTok Pixel + a conversion event mapped.
    // Default to Lead Generation since it works without pixel setup.
    confirmNote:
      "TikTok: 'Lead Generation' (default) or switch to 'Website Conversions' if your TikTok Pixel + conversion event are configured. Confirm in Ads Manager before publishing.",
  },
  AWARENESS: { tiktok: "Reach", confirmNote: null },
  ENGAGEMENT: {
    tiktok: "Community Interaction",
    confirmNote:
      "TikTok: 'Community Interaction' is the closest match; some TikTok regions surface it as 'Engagement'. Confirm in Ads Manager.",
  },
  EVENT: {
    tiktok: "Traffic",
    confirmNote:
      "TikTok: no direct 'Event' objective — default is 'Traffic' to the event landing page; switch to 'Website Conversions' if you have RSVP-event tracking configured. Confirm in Ads Manager.",
  },
};

function objectiveCells(objective) {
  return OBJECTIVE_MAP[objective] ?? { tiktok: objective, confirmNote: null };
}

// TikTok exposes a "Bid Strategy" choice with several values. The
// safest default for a fresh setup is "Cost cap" or "Lowest cost"
// depending on objective. Pick a conservative cross-cutting default
// (Lowest cost) and let the user adjust in TikTok Ads Manager.
const DEFAULT_BID_STRATEGY = "Lowest cost";
// Default placement strategy. TikTok's "Automatic Placements" pushes
// to TikTok + Pangle/news feed app. Safer to default to TikTok-only
// for a SquadAds export and let the user opt into broader placements.
const DEFAULT_PLACEMENTS = "TikTok feed only (set Automatic Placement in TikTok Ads Manager if desired)";

function emptyRow() {
  return COLUMNS.map(() => "");
}

function setCell(row, column, value) {
  row[COLUMNS.indexOf(column)] = value ?? "";
}

export const tiktokBulkTemplateCsv = {
  format: "tiktok_bulk_template_csv",
  aliases: [],
  label: "TikTok Ads bulk setup worksheet (CSV)",
  mimeType: "text/csv; charset=utf-8",
  extension: "csv",
  platform: "tiktok",
  isDirectImport: false,
  importStyle: "tiktok_bulk_template_csv",
  // Custom flag the FE reads — tells the user to download TikTok's
  // official template first, then paste this worksheet's rows in.
  requiresPlatformTemplateReview: true,
  notes: [
    "TikTok Ads Manager does not accept arbitrary CSV imports — its true",
    "bulk-edit format is an account-specific XLSX template downloaded",
    "from inside Ads Manager. This worksheet provides the same field set",
    "so you can paste the rows into TikTok's template, or use it as a",
    "manual-setup checklist. Asset URLs are reference only; upload the",
    "actual video/image files to TikTok's asset library first.",
  ].join(" "),
  render(bundle, pkg) {
    const warnings = [];

    const { tiktok: tiktokObjective, confirmNote: objectiveConfirmNote } =
      objectiveCells(bundle.package.objective);

    const campaignName = clip(bundle.package.name, LIMITS.CAMPAIGN_NAME, null, "Campaign Name", warnings);
    const adGroupName = clip(`${bundle.package.name} — group`, LIMITS.AD_GROUP_NAME, null, "Ad Group Name", warnings);

    const audience = bundle.audience ?? null;
    const budget = bundle.budget ?? null;
    const destinationUrl = bundle.destination?.url ?? "";
    if (destinationUrl && destinationUrl.length > LIMITS.LANDING_URL) {
      warnings.push({
        code: "FIELD_TOO_LONG",
        field: "Landing Page URL",
        limit: LIMITS.LANDING_URL,
        variantIndex: null,
        message: `Resolved landing URL exceeds TikTok's ${LIMITS.LANDING_URL}-char limit.`,
      });
    }

    const budgetType = budget?.dailyBudgetCents != null
      ? "Daily Budget"
      : budget?.totalBudgetCents != null
        ? "Lifetime Budget"
        : "";
    const budgetAmount =
      budget?.dailyBudgetCents != null
        ? (budget.dailyBudgetCents / 100).toFixed(2)
        : budget?.totalBudgetCents != null
          ? (budget.totalBudgetCents / 100).toFixed(2)
          : "";

    const ageTargeting = audience?.ageMin && audience?.ageMax
      ? `${audience.ageMin}-${audience.ageMax}`
      : "";
    const genderTargeting =
      Array.isArray(audience?.gendersJson) || Array.isArray(audience?.genders)
        ? (audience.genders ?? audience.gendersJson).join(", ")
        : "All";

    // Compliance line — surfaced in the Compliance Notes column on
    // every ad row so the TikTok account team sees it in the bulk
    // template at the point of setup. Validator already cleared
    // demographic targeting upstream (ads-02), so we never emit
    // narrow age/gender/postal here.
    const complianceNote =
      bundle.package.specialCategory === "HOUSING"
        ? "Housing-restricted creative. TikTok enforces restricted targeting for housing in supported regions — confirm targeting compliance (no narrow age/gender/postal) and keep copy free of protected-class language before publishing."
        : bundle.package.specialCategory !== "NONE"
          ? `Special category: ${bundle.package.specialCategory} — review TikTok's restricted-ad policies for this category before publishing.`
          : "";

    // Currency hint: TikTok Ads Manager shows budgets in the ad
    // account's billing currency. We include the SquadAds currency
    // in setup notes so a mismatch is visible.
    const currencyNote = budget?.currency
      ? `Budget currency: ${budget.currency}.`
      : "";

    const setupNoteBase = [
      objectiveConfirmNote,
      currencyNote,
      "Open TikTok Ads Manager → Tools → Bulk export to download the latest template; paste these rows into matching columns and validate before submitting.",
    ]
      .filter(Boolean)
      .join(" ");

    const rows = [csvRow(COLUMNS)];

    for (const c of bundle.creatives) {
      const adName = clip(`${campaignName} — Variant ${c.variantIndex}`, LIMITS.AD_NAME, c.variantIndex, "Ad Name", warnings);
      const adText = clip(c.primaryText, LIMITS.AD_TEXT, c.variantIndex, "Ad Text", warnings);

      const assetUrl = c.primaryAssetUrl ?? "";
      const assetNote = assetUrl
        ? ""
        : "No primary asset attached — upload the creative video/image directly inside TikTok Ads Manager.";

      const row = emptyRow();
      setCell(row, "Campaign Name", campaignName);
      setCell(row, "Campaign Objective", tiktokObjective);
      setCell(row, "Campaign Budget Type", budgetType);
      setCell(row, "Campaign Budget", budgetAmount);
      setCell(row, "Ad Group Name", adGroupName);
      setCell(row, "Placements", DEFAULT_PLACEMENTS);
      setCell(row, "Location Targeting", joinLocations(audience?.locations));
      setCell(row, "Age Targeting", ageTargeting);
      setCell(row, "Gender Targeting", genderTargeting);
      setCell(row, "Interest Targeting", (audience?.interests ?? []).join("; "));
      setCell(row, "Optimization Goal", optimizationGoalFor(bundle.package.objective));
      setCell(row, "Bid Strategy", DEFAULT_BID_STRATEGY);
      setCell(row, "Ad Name", adName);
      setCell(row, "Ad Text", adText);
      setCell(row, "Call To Action", c.cta ?? "");
      setCell(row, "Landing Page URL", destinationUrl);
      setCell(row, "Asset URL", assetUrl);
      setCell(row, "Compliance Notes", complianceNote);
      setCell(
        row,
        "Manual Setup Notes",
        [c.rationale ? `Rationale: ${c.rationale}` : "", setupNoteBase, assetNote]
          .filter(Boolean)
          .join(" | "),
      );
      rows.push(csvRow(row));
    }

    return {
      content: rows.join("\n"),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.tiktok-bulk.csv`,
      warnings,
    };
  },
};

// Optimization goal is a per-ad-group setting inside TikTok. We
// pick the most common safe default per objective. Account team
// will refine inside Ads Manager.
function optimizationGoalFor(objective) {
  switch (objective) {
    case "TRAFFIC":
      return "Click";
    case "LEADS":
      return "Lead";
    case "AWARENESS":
      return "Reach";
    case "ENGAGEMENT":
      return "Engagement";
    case "EVENT":
      return "Click";
    default:
      return "";
  }
}

function clip(value, limit, variantIndex, field, warnings) {
  const { value: trimmed, truncated } = truncateWithEllipsis(value, limit);
  if (truncated) {
    warnings.push({
      code: "FIELD_TRUNCATED",
      field,
      limit,
      variantIndex,
      message:
        variantIndex == null
          ? `${field} was truncated to fit TikTok's ${limit}-char limit.`
          : `Variant ${variantIndex} ${field} was truncated to fit TikTok's ${limit}-char limit.`,
    });
  }
  return trimmed;
}
