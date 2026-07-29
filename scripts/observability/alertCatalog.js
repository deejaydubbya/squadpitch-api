export const launchAlertCatalog = Object.freeze([
  ["api.5xx-rate", "P1", "API 5xx ratio > 2% for 5m with at least 50 requests"],
  ["auth.failure-spike", "P1", "401/403 rate > 3x 7-day baseline for 10m"],
  ["stripe.checkout-failure", "P1", "5 checkout failures in 10m or any live/test mode mismatch"],
  ["stripe.webhook-failure", "P1", "3 signature/processing failures in 10m or oldest retry > 15m"],
  ["queue.worker-failure", "P1", "Worker stopped, failed-job spike, or oldest eligible job > 10m"],
  ["publish.failure-rate", "P1", "5 failures or > 10% of attempts in 15m, grouped by provider"],
  ["database.unavailable", "P0", "Readiness DB check fails for 2 consecutive minutes"],
  ["postmark.delivery-failure", "P1", "5 send failures in 10m or inbound webhook silence during expected traffic"],
  ["twilio.delivery-failure", "P1", "5 failed/undelivered callbacks in 10m or webhook signature failures"],
  ["oauth.refresh-failure", "P1", "5 NEEDS_RECONNECT transitions for one provider in 15m"],
  ["ai.hosted-outage", "P1", "Hosted AI readiness fails or request failure ratio > 5% for 5m"],
  ["ai.abnormal-fallback-rate", "P1", "Fallback > 5% for 15m or any fallback on a no-fallback operation"],
]);

export function validateLaunchAlertCatalog(catalog = launchAlertCatalog) {
  const errors = [];
  const ids = new Set();
  for (const row of catalog) {
    const [id, severity, condition] = row;
    if (!id || ids.has(id)) errors.push(`Missing or duplicate alert id: ${id}`);
    ids.add(id);
    if (!["P0", "P1", "P2"].includes(severity)) errors.push(`${id}: invalid severity`);
    if (!condition) errors.push(`${id}: condition is required`);
  }
  return errors;
}
