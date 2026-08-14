import { runtimeIdentity } from "./processRole.js";

export const API_WORKER_COMPONENTS = Object.freeze([
  ["sp-worker-health", "worker", "continuous"],
  ["sp-scheduled-publish", "worker+scheduler", "1 minute"],
  ["sp-media-gen", "worker", "blocking"],
  ["sp-video-gen", "worker", "blocking"],
  ["sp-notification", "worker", "blocking"],
  ["sp-weekly-digest", "worker+scheduler", "weekly"],
  ["sp-metrics-sync", "worker+scheduler", "configured interval"],
  ["sp-analytics-recalc", "worker+scheduler", "configured interval"],
  ["sp-insights-refresh", "worker+scheduler", "configured interval"],
  ["sp-persona-training", "worker", "blocking"],
  ["sp-gbp-review-poll", "worker+scheduler", "10 minutes"],
  ["sp-youtube-comment-poll", "worker+scheduler", "15 minutes"],
  ["sp-threads-reply-poll", "worker+scheduler", "15 minutes"],
  ["sp-facebook-comments-poll", "worker+scheduler", "configured interval"],
  ["sp-instagram-comments-poll", "worker+scheduler", "configured interval"],
  ["sp-autopilot-evaluator", "worker+scheduler", "configured interval"],
  ["sp-contact-retention", "worker+scheduler", "daily"],
  ["sp-account-lifecycle", "worker+scheduler", "daily"],
  ["sp-prospect-preparation", "worker", "on demand"],
  ["sp-referral-qualification", "worker+scheduler", "daily"],
]);

export function topologySnapshot(environment = process.env) {
  const identity = runtimeIdentity(environment);
  return {
    event: "redis.topology.expected",
    ...identity,
    enabled: identity.processRole === "worker",
    components: API_WORKER_COMPONENTS.map(
      ([queueName, componentType, cadence]) => ({
        queueName,
        componentType,
        cadence,
      }),
    ),
  };
}

export function logRedisComponent({ event, queueName, componentType, enabled, ...extra }) {
  console.log(
    JSON.stringify({
      event,
      ...runtimeIdentity(),
      queueName,
      componentType,
      enabled,
      ...extra,
    }),
  );
}
