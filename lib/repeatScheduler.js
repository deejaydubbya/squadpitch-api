export function findDuplicateSchedulerKeys(
  schedulers,
  { keepKey, name, every },
) {
  return schedulers
    .filter(
      (scheduler) =>
        scheduler.key !== keepKey &&
        scheduler.name === name &&
        scheduler.every === every,
    )
    .map((scheduler) => scheduler.key);
}
