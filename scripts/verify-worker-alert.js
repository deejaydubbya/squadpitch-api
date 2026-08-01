import {
  captureSyntheticWorkerHealthEvent,
  initSentry,
} from "../lib/sentry.js";

const configured = await initSentry();
if (!configured) {
  console.error("Worker-health Sentry verification failed: not configured");
  process.exitCode = 1;
} else {
  const result = await captureSyntheticWorkerHealthEvent();
  if (!result.delivered || !result.eventId) {
    console.error("Worker-health Sentry verification failed: delivery timeout");
    process.exitCode = 1;
  } else {
    console.log(`PASS event_id=${result.eventId}`);
  }
}
