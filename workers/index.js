import { assertProcessRole } from "../lib/processRole.js";
import { API_WORKER_COMPONENTS, logRedisComponent } from "../lib/redisTopology.js";

let resourcesPromise;

const starters = [
  ["../domains/workerHealth/workerHealth.service.js", "startWorkerHealthWorker"],
  ["./scheduledPublishWorker.js", "startScheduledPublishWorker"],
  ["./mediaGenWorker.js", "startMediaGenWorker"],
  ["./videoGenWorker.js", "startVideoGenWorker"],
  ["./notificationWorker.js", "startNotificationWorker"],
  ["./weeklyDigestWorker.js", "startWeeklyDigestWorker"],
  ["./metricsSyncWorker.js", "startMetricsSyncWorker"],
  ["./recalculateAnalyticsWorker.js", "startRecalculateAnalyticsWorker"],
  ["./refreshInsightsWorker.js", "startRefreshInsightsWorker"],
  ["./personaTrainingWorker.js", "startPersonaTrainingWorker"],
  ["./gbpReviewPollerWorker.js", "startGbpReviewPollerWorker"],
  ["./youtubeCommentPollerWorker.js", "startYouTubeCommentPollerWorker"],
  ["./threadsReplyPollerWorker.js", "startThreadsReplyPollerWorker"],
  ["./facebookCommentPollerWorker.js", "startFacebookCommentPollerWorker"],
  ["./instagramCommentPollerWorker.js", "startInstagramCommentPollerWorker"],
  ["./autopilotEvaluatorWorker.js", "startAutopilotEvaluatorWorker"],
  ["./contactRetentionWorker.js", "startContactRetentionWorker"],
  ["./accountLifecycleWorker.js", "startAccountLifecycleWorker"],
  ["./prospectPreparationWorker.js", "startProspectPreparationWorker"],
];

export function startWorkers() {
  assertProcessRole("worker");
  if (resourcesPromise) {
    logRedisComponent({
      event: "bullmq.duplicate_initialization_blocked",
      queueName: "all",
      componentType: "worker-bootstrap",
      enabled: true,
    });
    return resourcesPromise;
  }

  resourcesPromise = Promise.all(
    starters.map(async ([modulePath, exportName], index) => {
      const module = await import(modulePath);
      const resource = module[exportName]();
      const [queueName, componentType, cadence] = API_WORKER_COMPONENTS[index];
      logRedisComponent({
        event: "bullmq.worker.initialized",
        queueName,
        componentType,
        enabled: Boolean(resource),
        cadence,
        drainDelaySeconds: 15,
        stalledIntervalSeconds: 60,
      });
      return resource;
    }),
  );
  return resourcesPromise;
}

export async function stopWorkers() {
  if (!resourcesPromise) return;
  const resources = await resourcesPromise;
  await Promise.allSettled(
    resources.filter(Boolean).map((resource) => resource.close?.()),
  );
  resourcesPromise = undefined;
}

export function resetWorkerRegistryForTest() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Worker registry reset is test-only");
  }
  resourcesPromise = undefined;
}

export function primeWorkerRegistryForTest(resources) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Worker registry priming is test-only");
  }
  resourcesPromise = Promise.resolve(resources);
  return resourcesPromise;
}
