// industry-01 — shared typed errors for industry gating.
//
// When a feature is industry-specific (e.g. autopilot, listing
// ingestion, real-estate-only URL extraction), the service guards
// throw `IndustryNotSupportedError` instead of silently running
// the real-estate code path for non-RE workspaces. Route handlers
// translate this into a 400 with code `INDUSTRY_NOT_SUPPORTED` so
// the FE can render a friendly "not yet available for your
// industry" message instead of a generic crash.
//
// The shape mirrors ExportError (ads/ads.export.errors.js) so the
// existing `if (typeof err.status === "number")` route handlers
// pick it up automatically.

export class IndustryNotSupportedError extends Error {
  constructor(message, { actualIndustry = null, requiredIndustry = null } = {}) {
    super(message);
    this.status = 400;
    this.code = "INDUSTRY_NOT_SUPPORTED";
    this.actualIndustry = actualIndustry;
    this.requiredIndustry = requiredIndustry;
  }
}

// Convenience: throw if the workspace industry doesn't match.
// `actual` may be null/undefined for no-industry workspaces — that's
// a valid state and just means the feature isn't yet supported.
export function requireIndustry(featureName, actual, required) {
  const list = Array.isArray(required) ? required : [required];
  if (!list.includes(actual)) {
    const expected = list.join(" or ");
    throw new IndustryNotSupportedError(
      `${featureName} is only available for ${expected} workspaces (current: ${actual ?? "no industry selected"}).`,
      { actualIndustry: actual ?? null, requiredIndustry: list[0] },
    );
  }
}

// Route-handler glue: if `err` is an IndustryNotSupportedError,
// send a 400 with INDUSTRY_NOT_SUPPORTED + actualIndustry +
// requiredIndustry fields so the FE can render a friendly message
// and (optionally) a deep-link to the workspace settings page.
// Returns true if it handled the error, false otherwise — caller
// uses the standard `if (handled) return;` pattern.
export function trySendIndustryError(res, sendError, err) {
  if (err instanceof IndustryNotSupportedError) {
    sendError(res, err.status, err.code, err.message, {
      actualIndustry: err.actualIndustry,
      requiredIndustry: err.requiredIndustry,
    });
    return true;
  }
  return false;
}
