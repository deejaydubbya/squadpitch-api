// Human-readable Markdown brief — what you'd hand to an agency or
// a paid-media specialist who'll set up the campaign manually.
// Output is byte-for-byte compatible with the pre-ads-04
// `format=markdown` export so existing integrations keep working.

import { describeSource, formatMoney, slugifyForFilename } from "./_helpers.js";

export const agencyMarkdown = {
  format: "agency_markdown",
  aliases: ["markdown", "md"],
  label: "Agency brief (Markdown)",
  mimeType: "text/markdown; charset=utf-8",
  extension: "md",
  platform: "any",
  isDirectImport: false,
  notes: [
    "Plain-language brief covering copy, audience, budget, destination,",
    "and compliance notes. Designed to be pasted into a project doc or",
    "shared with a paid-media specialist — not a platform import file.",
  ].join(" "),
  render(bundle, pkg) {
    return {
      content: renderMarkdown(bundle),
      filename: `${slugifyForFilename(pkg.name)}-${pkg.id.slice(-6)}.md`,
    };
  },
};

function renderMarkdown(bundle) {
  const lines = [];
  lines.push(`# ${bundle.package.name}`);
  lines.push("");
  lines.push(`**Objective:** ${bundle.package.objective}`);
  lines.push(`**Status:** ${bundle.package.status}`);
  lines.push(`**Special category:** ${bundle.package.specialCategory}`);
  lines.push(`**Exported:** ${bundle.exportedAt}`);
  if (bundle.package.source) {
    lines.push("");
    lines.push("## Source");
    lines.push(`- ${bundle.package.source.kind}: ${describeSource(bundle.package.source)}`);
  }

  lines.push("");
  lines.push("## Destination");
  if (bundle.destination) {
    lines.push(`- Kind: ${bundle.destination.kind}`);
    if (bundle.destination.url) lines.push(`- URL: ${bundle.destination.url}`);
    if (bundle.destination.socialProfile) lines.push(`- Social profile: ${bundle.destination.socialProfile}`);
    if (bundle.destination.pixelIds.length > 0) lines.push(`- Pixels: ${bundle.destination.pixelIds.join(", ")}`);
  } else {
    lines.push("_(no destination configured)_");
  }

  lines.push("");
  lines.push("## Creatives");
  for (const c of bundle.creatives) {
    lines.push("");
    lines.push(`### Variant ${c.variantIndex}${c.channelHint ? ` — ${c.channelHint}` : ""}`);
    lines.push(`**Headline:** ${c.headline}`);
    lines.push("");
    lines.push(`**Primary text:**`);
    lines.push(c.primaryText);
    if (c.description) lines.push("", `**Description:** ${c.description}`);
    if (c.cta) lines.push("", `**CTA:** ${c.cta}`);
    if (c.primaryAssetUrl) lines.push("", `**Primary asset:** ${c.primaryAssetUrl}`);
    if (c.additionalAssetUrls.length > 0) {
      lines.push("", `**Additional assets:**`);
      for (const u of c.additionalAssetUrls) lines.push(`- ${u}`);
    }
    if (c.rationale) lines.push("", `_${c.rationale}_`);
  }

  if (bundle.audience) {
    lines.push("");
    lines.push("## Audience");
    if (bundle.audience.locations.length > 0) {
      lines.push(
        `- Locations: ${bundle.audience.locations.map((l) => `${l.value} (${l.kind})`).join(", ")}`,
      );
    }
    if (bundle.audience.ageMin || bundle.audience.ageMax) {
      lines.push(`- Age range: ${bundle.audience.ageMin ?? "—"} to ${bundle.audience.ageMax ?? "—"}`);
    }
    lines.push(`- Genders: ${(bundle.audience.genders || []).join(", ") || "all"}`);
    if (bundle.audience.interests.length > 0) {
      lines.push(`- Interests: ${bundle.audience.interests.join(", ")}`);
    }
    if (bundle.audience.languages.length > 0) {
      lines.push(`- Languages: ${bundle.audience.languages.join(", ")}`);
    }
    if (bundle.audience.customAudienceHints.length > 0) {
      lines.push("- Custom audiences:");
      for (const h of bundle.audience.customAudienceHints) {
        lines.push(`  - ${h.kind}: ${h.description}`);
      }
    }
    if (bundle.audience.housingRestricted) {
      lines.push("- ⚠ Housing-restricted: demographic targeting cleared.");
    }
  }

  if (bundle.budget) {
    lines.push("");
    lines.push("## Budget");
    if (bundle.budget.dailyBudgetCents != null) {
      lines.push(`- Daily: ${formatMoney(bundle.budget.dailyBudgetCents, bundle.budget.currency)}`);
    }
    if (bundle.budget.totalBudgetCents != null) {
      lines.push(`- Total: ${formatMoney(bundle.budget.totalBudgetCents, bundle.budget.currency)}`);
    }
    if (bundle.budget.durationDays) lines.push(`- Duration: ${bundle.budget.durationDays} days`);
    if (bundle.budget.startsAt) lines.push(`- Starts: ${new Date(bundle.budget.startsAt).toISOString().slice(0, 10)}`);
    if (bundle.budget.endsAt) lines.push(`- Ends: ${new Date(bundle.budget.endsAt).toISOString().slice(0, 10)}`);
  }

  lines.push("");
  lines.push("## Compliance");
  lines.push("");
  lines.push(bundle.compliance.notLaunchedDisclaimer);
  if (bundle.compliance.housingDisclaimer) {
    lines.push("");
    lines.push(bundle.compliance.housingDisclaimer);
  }
  if (bundle.compliance.reviewNotes) {
    lines.push("");
    lines.push("**Internal review notes:**");
    lines.push(bundle.compliance.reviewNotes);
  }
  return lines.join("\n");
}
