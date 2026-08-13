// BullMQ queue singletons for Squadpitch workers.

import { Queue } from "bullmq";
import { getRedisConnection } from "../redis.js";

let mediaGenQueue = null;

export function getMediaGenQueue() {
  if (mediaGenQueue) return mediaGenQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — mediaGenQueue disabled");
    return null;
  }

  mediaGenQueue = new Queue("sp-media-gen", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  return mediaGenQueue;
}

let notificationQueue = null;

export function getNotificationQueue() {
  if (notificationQueue) return notificationQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — notificationQueue disabled");
    return null;
  }

  notificationQueue = new Queue("sp-notification", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  return notificationQueue;
}

let metricsSyncQueue = null;

export function getMetricsSyncQueue() {
  if (metricsSyncQueue) return metricsSyncQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — metricsSyncQueue disabled");
    return null;
  }

  metricsSyncQueue = new Queue("sp-metrics-sync", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  return metricsSyncQueue;
}

let analyticsRecalcQueue = null;

export function getAnalyticsRecalcQueue() {
  if (analyticsRecalcQueue) return analyticsRecalcQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — analyticsRecalcQueue disabled");
    return null;
  }

  analyticsRecalcQueue = new Queue("sp-analytics-recalc", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  return analyticsRecalcQueue;
}

let insightsRefreshQueue = null;

export function getInsightsRefreshQueue() {
  if (insightsRefreshQueue) return insightsRefreshQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — insightsRefreshQueue disabled");
    return null;
  }

  insightsRefreshQueue = new Queue("sp-insights-refresh", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  return insightsRefreshQueue;
}

let videoGenQueue = null;

export function getVideoGenQueue() {
  if (videoGenQueue) return videoGenQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — videoGenQueue disabled");
    return null;
  }

  videoGenQueue = new Queue("sp-video-gen", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  return videoGenQueue;
}

let personaTrainingQueue = null;

export function getPersonaTrainingQueue() {
  if (personaTrainingQueue) return personaTrainingQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — personaTrainingQueue disabled");
    return null;
  }

  personaTrainingQueue = new Queue("sp-persona-training", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 20,
      removeOnFail: 100,
    },
  });

  return personaTrainingQueue;
}

let scheduledPublishQueue = null;

export function getScheduledPublishQueue() {
  if (scheduledPublishQueue) return scheduledPublishQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — scheduledPublishQueue disabled");
    return null;
  }

  scheduledPublishQueue = new Queue("sp-scheduled-publish", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  return scheduledPublishQueue;
}

let gbpReviewPollQueue = null;

export function getGbpReviewPollQueue() {
  if (gbpReviewPollQueue) return gbpReviewPollQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — gbpReviewPollQueue disabled");
    return null;
  }

  gbpReviewPollQueue = new Queue("sp-gbp-review-poll", {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });

  return gbpReviewPollQueue;
}

let weeklyDigestQueue = null;

let prospectPreparationQueue = null;

export function getProspectPreparationQueue() {
  if (prospectPreparationQueue) return prospectPreparationQueue;
  const connection = getRedisConnection();
  if (!connection) return null;
  prospectPreparationQueue = new Queue("sp-prospect-preparation", {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 500 },
    },
  });
  return prospectPreparationQueue;
}

export function getWeeklyDigestQueue() {
  if (weeklyDigestQueue) return weeklyDigestQueue;

  const connection = getRedisConnection();
  if (!connection) {
    console.warn("[QUEUES] No Redis connection — weeklyDigestQueue disabled");
    return null;
  }

  weeklyDigestQueue = new Queue("sp-weekly-digest", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  return weeklyDigestQueue;
}

/**
 * Returns all queue instances as { name, queue } pairs.
 * Skips any where the queue getter returns null (no Redis).
 */
export function getAllQueues() {
  const entries = [
    { name: "sp-media-gen", getter: getMediaGenQueue },
    { name: "sp-video-gen", getter: getVideoGenQueue },
    { name: "sp-persona-training", getter: getPersonaTrainingQueue },
    { name: "sp-notification", getter: getNotificationQueue },
    { name: "sp-metrics-sync", getter: getMetricsSyncQueue },
    { name: "sp-analytics-recalc", getter: getAnalyticsRecalcQueue },
    { name: "sp-insights-refresh", getter: getInsightsRefreshQueue },
    { name: "sp-scheduled-publish", getter: getScheduledPublishQueue },
    { name: "sp-weekly-digest", getter: getWeeklyDigestQueue },
    { name: "sp-gbp-review-poll", getter: getGbpReviewPollQueue },
    { name: "sp-prospect-preparation", getter: getProspectPreparationQueue },
  ];

  return entries
    .map(({ name, getter }) => ({ name, queue: getter() }))
    .filter(({ queue }) => queue !== null);
}
