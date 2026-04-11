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
      attempts: 2,
      backoff: { type: "fixed", delay: 3_000 },
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
      attempts: 2,
      backoff: { type: "fixed", delay: 10_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  return videoGenQueue;
}
