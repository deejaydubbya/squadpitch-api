// Tiny ops-alert helper. Posts to a Slack incoming webhook if
// OPS_SLACK_WEBHOOK_URL is set, otherwise emits a structured warning to
// stdout. Designed to be a one-call dependency for workers — no client,
// no SDK, no buffering.
//
// All alerts are deduped by `key` for `dedupWindowMs` so a wedged worker
// won't spam the channel. The dedup state is in-memory per process; that's
// good enough for a single-pod worker.

import { env } from "../config/env.js";

const DEFAULT_DEDUP_MS = 10 * 60 * 1000; // 10 min
const lastSentAt = new Map(); // key -> timestamp ms

/**
 * Send an ops alert.
 *
 * @param {{
 *   key: string,                 // unique-per-condition dedup key
 *   severity?: "info"|"warning"|"critical",
 *   title: string,
 *   message?: string,
 *   context?: Record<string, unknown>,
 *   dedupWindowMs?: number,
 * }} alert
 * @returns {Promise<{sent: boolean, channel: "slack"|"log"|"deduped"}>}
 */
export async function sendOpsAlert(alert) {
  if (!alert?.key || !alert?.title) {
    return { sent: false, channel: "log" };
  }

  const now = Date.now();
  const windowMs = alert.dedupWindowMs ?? DEFAULT_DEDUP_MS;
  const last = lastSentAt.get(alert.key);
  if (last && now - last < windowMs) {
    return { sent: false, channel: "deduped" };
  }
  lastSentAt.set(alert.key, now);

  const severity = alert.severity ?? "warning";
  const webhook = env.OPS_SLACK_WEBHOOK_URL;

  if (webhook) {
    try {
      const text = formatSlackText(severity, alert);
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        // Slack is misconfigured / down — fall through to log so we don't
        // silently drop the alert.
        logAlert(severity, alert, `slack_http_${res.status}`);
        return { sent: false, channel: "log" };
      }
      return { sent: true, channel: "slack" };
    } catch (err) {
      logAlert(severity, alert, err?.message ?? "slack_error");
      return { sent: false, channel: "log" };
    }
  }

  logAlert(severity, alert, "no_webhook_configured");
  return { sent: true, channel: "log" };
}

function formatSlackText(severity, alert) {
  const emoji =
    severity === "critical" ? ":rotating_light:" : severity === "info" ? ":information_source:" : ":warning:";
  const ctx = alert.context
    ? "\n```" + JSON.stringify(alert.context, null, 2) + "```"
    : "";
  const msg = alert.message ? `\n${alert.message}` : "";
  return `${emoji} *${alert.title}*${msg}${ctx}`;
}

function logAlert(severity, alert, reason) {
  // Single-line structured log for easy ops grep.
  console.warn(
    JSON.stringify({
      ops_alert: true,
      severity,
      key: alert.key,
      title: alert.title,
      message: alert.message ?? null,
      context: alert.context ?? null,
      reason,
      ts: new Date().toISOString(),
    })
  );
}

/** Test-only: clear the dedup state. */
export function _resetOpsAlertDedup() {
  lastSentAt.clear();
}
