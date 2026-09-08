import { randomUUID } from 'node:crypto';

const EVENT_BATCH_SIZE = 100;
const EVENT_BUFFER_LIMIT = 1000;
const EVENT_FLUSH_DELAY_MS = 2000;
const EVENT_RETRY_DELAY_MS = 5000;

// Repository: insertBatch(events), resolving only after the complete batch persists.
export function createAnalyticsService(
  repository,
  { onWriteFailure = () => undefined } = {},
) {
  let eventFlushPromise = null;
  const eventBuffer = [];
  let scheduleEventFlushTimer = () => undefined;
  let cancelEventFlushTimer = () => undefined;

  function scheduleEventFlush(delay = EVENT_FLUSH_DELAY_MS) {
    if (!eventBuffer.length) return;
    scheduleEventFlushTimer(delay);
  }

  function cancelScheduledEventFlush() {
    cancelEventFlushTimer();
  }

  function enqueue(value) {
    if (eventBuffer.length >= EVENT_BUFFER_LIMIT)
      return {
        ok: false,
        code: 'EVENT_QUEUE_FULL',
        message: '统计队列繁忙，请稍后再试。',
      };
    eventBuffer.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...value,
    });
    if (eventBuffer.length >= EVENT_BATCH_SIZE) {
      cancelScheduledEventFlush();
      void flushEventBuffer().catch(() => undefined);
    } else scheduleEventFlush();
    return { ok: true };
  }

  async function flushEventBuffer({ drain = false } = {}) {
    if (drain) cancelScheduledEventFlush();
    let failed = false;
    try {
      do {
        if (!eventFlushPromise) {
          if (!eventBuffer.length) break;
          const batch = eventBuffer.splice(0, EVENT_BATCH_SIZE);
          eventFlushPromise = (async () => {
            try {
              await repository.insertBatch(batch);
            } catch (error) {
              eventBuffer.unshift(...batch);
              onWriteFailure(error);
              throw error;
            }
          })();
        }
        const pendingFlush = eventFlushPromise;
        try {
          await pendingFlush;
        } finally {
          if (eventFlushPromise === pendingFlush) eventFlushPromise = null;
        }
        if (drain) cancelScheduledEventFlush();
      } while (drain && eventBuffer.length);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (eventBuffer.length) {
        const delay = failed
          ? EVENT_RETRY_DELAY_MS
          : eventBuffer.length >= EVENT_BATCH_SIZE
            ? 0
            : EVENT_FLUSH_DELAY_MS;
        scheduleEventFlush(delay);
      }
    }
  }

  return {
    enqueue,
    flushEventBuffer,
    cancelScheduledEventFlush,
    get eventBufferLength() {
      return eventBuffer.length;
    },
    setEventTimerControls(controls) {
      scheduleEventFlushTimer = controls.schedule;
      cancelEventFlushTimer = controls.cancel;
    },
  };
}
