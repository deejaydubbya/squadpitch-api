export const BOUNDED_JOB_RETENTION = Object.freeze({
  removeOnComplete: { age: 24 * 60 * 60, count: 100 },
  removeOnFail: { age: 14 * 24 * 60 * 60, count: 500 },
});

// BullMQ uses blocking reads; a modest idle delay reduces empty command churn
// while preserving prompt pickup and stalled-job recovery.
export const CONSERVATIVE_WORKER_OPTIONS = Object.freeze({
  drainDelay: 15,
  stalledInterval: 60_000,
  lockDuration: 60_000,
  maxStalledCount: 2,
});

export function boundedQueueOptions(connection, overrides = {}) {
  return {
    connection,
    defaultJobOptions: { ...BOUNDED_JOB_RETENTION },
    ...overrides,
  };
}
