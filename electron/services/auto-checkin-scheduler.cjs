const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

function createAutoCheckinScheduler({
  checkinService,
  getNextCycleDelay,
  notificationName,
  notifyFailure = () => {},
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetries = DEFAULT_MAX_RETRIES
}) {
  let enabled = false;
  let started = false;
  let timer = null;
  let generation = 0;

  function clearTimer() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function schedule(delayMs, retryCount, expectedGeneration) {
    clearTimer();
    if (!started || !enabled || generation !== expectedGeneration) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void run(retryCount, expectedGeneration);
    }, Math.max(0, delayMs));
    timer?.unref?.();
  }

  function scheduleNextCycle(expectedGeneration) {
    schedule(getNextCycleDelay(now()), 0, expectedGeneration);
  }

  async function run(retryCount, expectedGeneration) {
    if (!started || !enabled || generation !== expectedGeneration) return;
    try {
      await checkinService.claim();
      if (generation === expectedGeneration) scheduleNextCycle(expectedGeneration);
    } catch (error) {
      if (!started || !enabled || generation !== expectedGeneration) return;
      if (error?.code === "activity-inactive") {
        scheduleNextCycle(expectedGeneration);
        return;
      }
      if (error?.retryable !== false && retryCount < maxRetries) {
        schedule(retryDelayMs, retryCount + 1, expectedGeneration);
        return;
      }
      try {
        notifyFailure(error);
      } catch (notifyError) {
        console.error(`Failed to show ${notificationName} auto check-in notification:`, notifyError);
      }
      scheduleNextCycle(expectedGeneration);
    }
  }

  function setEnabled(nextEnabled) {
    const normalized = nextEnabled === true;
    if (enabled === normalized && started) return;
    enabled = normalized;
    generation += 1;
    clearTimer();
    if (started && enabled) schedule(0, 0, generation);
  }

  function start(nextEnabled) {
    clearTimer();
    started = true;
    enabled = nextEnabled === true;
    generation += 1;
    if (enabled) schedule(0, 0, generation);
  }

  function shutdown() {
    started = false;
    enabled = false;
    generation += 1;
    clearTimer();
  }

  function resume() {
    if (started && enabled) {
      generation += 1;
      schedule(0, 0, generation);
    }
  }

  return { setEnabled, shutdown, start, resume };
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  createAutoCheckinScheduler
};
