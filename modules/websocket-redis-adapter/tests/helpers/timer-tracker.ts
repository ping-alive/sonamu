import { vi } from "vitest";

export type TrackedTimer = {
  handle: NodeJS.Timeout;
  delayMs: number;
  fired: boolean;
  cleared: boolean;
};

export type TimeoutTracker = { timers: TrackedTimer[]; stop(): void };

/**
 * 추적을 시작한 뒤 만들어진 setTimeout을 기록한다. 실제 타이머는 그대로 만들되 실행/해제 여부를 기록한다.
 * process.getActiveResourcesInfo()의 개수 비교는 다른 타이머가 같은 시점에 만료되면 결과가 흔들리므로 쓰지 않고,
 * fake timer는 node-redis 내부 타이머와 실제 소켓 I/O 진행까지 바꿔 버리므로 쓰지 않는다.
 */
export function trackTimeouts(): TimeoutTracker {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers: TrackedTimer[] = [];
  const setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delayMs, ...args) => {
      const tracked: TrackedTimer = {
        handle: realSetTimeout(() => {
          tracked.fired = true;
          callback(...args);
        }, delayMs),
        delayMs: delayMs ?? 0,
        fired: false,
        cleared: false,
      };
      timers.push(tracked);
      return tracked.handle;
    });
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    for (const tracked of timers) {
      if (tracked.handle === handle) {
        tracked.cleared = true;
      }
    }
    realClearTimeout(handle);
  });
  return {
    timers,
    stop() {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    },
  };
}

// 아직 실행/해제되지 않았고 event loop를 붙잡는(ref된) 타이머의 delay 목록
export function pendingRefTimerDelays(tracker: TimeoutTracker): number[] {
  return tracker.timers
    .filter((timer) => !timer.fired && !timer.cleared && timer.handle.hasRef())
    .map((timer) => timer.delayMs);
}
