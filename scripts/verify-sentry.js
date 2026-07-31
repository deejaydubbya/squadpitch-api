import { captureSyntheticVerificationEvent, initSentry } from "../lib/sentry.js";

if (!(await initSentry())) {
  console.error("Sentry is not configured. Set SENTRY_DSN for this operator command.");
  process.exit(2);
}
const result = await captureSyntheticVerificationEvent();
console.log(`Synthetic Sentry event ${result.delivered ? "submitted" : "timed out"}; event ID: ${result.eventId}`);
process.exit(result.delivered ? 0 : 1);
