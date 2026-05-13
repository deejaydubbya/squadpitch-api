// Bridge from squadpitch-api → squadpitch-public's revalidate
// webhook. Called whenever a SitePage transitions to
// PUBLISHED / UNPUBLISHED, or its content changes after publish,
// so the runtime drops its cached HTML for that path
// immediately instead of waiting for the ISR window.
//
// Fire-and-forget: if the runtime is briefly unreachable we
// don't fail the API write that triggered this. The page will
// catch up on the next natural ISR refresh.

import { env } from "../../config/env.js";

/**
 * POST to <runtime>/api/revalidate with the bearer token.
 * Returns { ok, status } so callers can log; never throws.
 */
export async function triggerRuntimeRevalidate({ clientSlug, pageSlug }) {
  const url = env.RUNTIME_REVALIDATE_URL;
  const token = env.RUNTIME_REVALIDATE_TOKEN;

  if (!url || !token) {
    // Dev / staging may not have the runtime endpoint configured.
    // Logging once helps catch missing env in prod without
    // spamming. Returning early is intentional fail-soft behavior.
    return { ok: false, status: 0, reason: "RUNTIME_REVALIDATE_NOT_CONFIGURED" };
  }
  if (typeof clientSlug !== "string" || !clientSlug) {
    return { ok: false, status: 0, reason: "MISSING_CLIENT_SLUG" };
  }
  if (typeof pageSlug !== "string" || !pageSlug) {
    return { ok: false, status: 0, reason: "MISSING_PAGE_SLUG" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ clientSlug, pageSlug }),
      // Don't let a slow runtime stall API requests.
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, reason: err?.message ?? String(err) };
  }
}
