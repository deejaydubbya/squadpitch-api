// SquadAds export — turn an AdPackage into a downloadable artifact.
//
// As of ads-04 this module is a thin orchestrator: it (a) loads the
// package + runs the readiness validator, (b) hands off bundle
// construction to ./exporters/bundle.js, (c) dispatches to the
// per-format renderer in ./exporters/index.js, and (d) handles the
// preview-vs-download status mutation. The actual platform-specific
// formatting lives in ./exporters/* — adding a new platform should
// not require editing this file.

import { prisma } from "../../prisma.js";
import { validatePackageReady } from "./ads.service.js";
import { ExportError } from "./ads.export.errors.js";
import { buildCanonicalBundle } from "./exporters/bundle.js";
import { getExporter } from "./exporters/index.js";

export { ExportError };

// Ads-03 — `mode` controls whether the call mutates the package.
//   - 'preview'  (default): generate the bundle + bytes only. No
//     exportsJson append, no READY→EXPORTED status flip. Safe to
//     call from a "Preview" button without surprising the user.
//   - 'download': append to exportsJson and flip READY→EXPORTED.
//     This is the real export — the user pressed "Download".
//
// Ads-04 — `format` is dispatched to ./exporters/index.js. Old
// aliases ('json' → squadads_json, 'markdown' → agency_markdown)
// continue to resolve to the same renderers.
export async function exportPackage(
  clientId,
  packageId,
  userId,
  { format = "squadads_json", mode = "preview" } = {},
) {
  const exporter = getExporter(format);
  if (!exporter) {
    throw new ExportError(`Unknown export format: ${format}`, {
      status: 400,
      code: "UNSUPPORTED_EXPORT_FORMAT",
    });
  }

  const pkg = await prisma.adPackage.findFirst({
    where: { id: packageId, clientId },
    include: {
      creatives: { orderBy: { variantIndex: "asc" } },
      audience: true,
      budget: true,
      destination: true,
    },
  });
  if (!pkg) throw new ExportError("Ad package not found", { status: 404, code: "AD_PACKAGE_NOT_FOUND" });
  if (pkg.status !== "READY" && pkg.status !== "EXPORTED") {
    throw new ExportError("Package must be READY before exporting", {
      status: 400,
      code: "PACKAGE_NOT_READY",
    });
  }
  if (!pkg.creatives || pkg.creatives.length === 0) {
    throw new ExportError("Package has no creatives", { status: 400, code: "NO_CREATIVES" });
  }

  // Ads-02 — defense in depth. A package may have been READY at
  // status-flip time but had its destination unpublished, its
  // copy edited to include a risky phrase, etc. Re-run the full
  // validator at export time so we never ship a non-compliant
  // bundle. Translate the validator's typed errors into
  // ExportError so the route layer sees the same shape it
  // already handles.
  try {
    await validatePackageReady(pkg);
  } catch (err) {
    if (err.code === "READY_PRECONDITIONS_FAILED" || err.code === "COMPLIANCE_COPY_REVIEW_FAILED") {
      const exportErr = new ExportError(err.message, { status: 400, code: err.code });
      if (err.missing) exportErr.missing = err.missing;
      if (err.findings) exportErr.findings = err.findings;
      throw exportErr;
    }
    throw err;
  }

  // Canonical bundle is built once per export, regardless of format.
  // Per-format renderers receive the same input and produce the
  // platform-specific bytes. Keeping bundle creation here means a
  // new renderer can be added without touching prisma.
  const bundle = await buildCanonicalBundle(pkg);
  // Renderers may optionally return `warnings[]` (ads-05) — e.g.
  // Google CSV flags fields it had to truncate. We pass them
  // through to the response so the FE can surface them next to
  // the download button instead of letting bad copy ship silently.
  const rendered = exporter.render(bundle, pkg);
  const { content, filename, warnings } = rendered;

  // Ads-03 — only the 'download' path mutates. Preview is a pure
  // read so a "Preview" button can't silently flip a package to
  // EXPORTED behind the user's back.
  if (mode === "download") {
    const exportsEntry = {
      format: exporter.format,
      filename,
      generatedAt: new Date().toISOString(),
      generatedBy: userId,
    };
    const existingExports = Array.isArray(pkg.exportsJson) ? pkg.exportsJson : [];
    await prisma.adPackage.update({
      where: { id: pkg.id },
      data: {
        exportsJson: [...existingExports, exportsEntry],
        status: pkg.status === "READY" ? "EXPORTED" : pkg.status,
      },
    });
  }

  return {
    format: exporter.format,
    label: exporter.label,
    filename,
    mimeType: exporter.mimeType,
    extension: exporter.extension,
    platform: exporter.platform,
    isDirectImport: exporter.isDirectImport,
    // Ads-05 — `importStyle` (when set) names the platform-specific
    // import path the bytes target (e.g. 'google_ads_editor_csv').
    // Renderers that aren't tied to a specific importer omit it.
    importStyle: exporter.importStyle ?? null,
    // Ads-06 — true for renderers that require the user to download
    // a platform-specific template first (TikTok bulk edit). The
    // FE renders an honest "paste these rows into TikTok's
    // template" hint instead of a deceptive "one-click import".
    requiresPlatformTemplateReview: exporter.requiresPlatformTemplateReview ?? false,
    platformNotes: exporter.notes,
    warnings: Array.isArray(warnings) ? warnings : [],
    content,
    bundle,
    mode,
  };
}
