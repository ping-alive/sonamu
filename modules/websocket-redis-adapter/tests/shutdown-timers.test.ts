import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createRedisWebSocketAdapter, type RedisWebSocketAdapter } from "../src/index";
import { type StartedRedis, startRedis, timeSettle, uniqueName } from "./helpers/redis-container";
import { FAST_ADAPTER_OPTIONS, shutdownAdapters } from "./helpers/runtime-harness";
import { registerSession } from "./helpers/store-helpers";
import { trackTimeouts } from "./helpers/timer-tracker";

describe("shutdown 타이머 정리", () => {
  let redis: StartedRedis;
  const adapters: RedisWebSocketAdapter[] = [];

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await shutdownAdapters(adapters);
    await redis?.stop();
  });

  it("빠르게 끝난 shutdown은 drainTimeoutMs 동안 event loop를 붙잡는 타이머를 남기지 않는다", async () => {
    const prefix = uniqueName("shutdown-timers");
    const nodeId = uniqueName("node");
    const adapter = createRedisWebSocketAdapter({
      redis: { url: redis.url },
      prefix,
      nodeId,
      ...FAST_ADAPTER_OPTIONS,
      // 남은 타이머가 있으면 테스트 동안 확실히 보이도록 길게 둔다
      drainTimeoutMs: 30_000,
    });
    adapters.push(adapter);
    await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });
    await adapter.presenceStore.join("s1", "room-1");
    await adapter.clusterBus.subscribe(() => {});

    const tracker = trackTimeouts();
    const shutdown = await timeSettle(
      Promise.all([adapter.presenceStore.shutdown(), adapter.clusterBus.shutdown()]),
    );
    tracker.stop();

    expect(shutdown.status).toBe("fulfilled");
    // 진행 중인 쓰기가 없으므로 drain을 기다리지 않는다
    expect(shutdown.elapsedMs).toBeLessThan(2_000);
    // shutdown 중에 만든 ref된 타이머는 shutdown이 끝날 때 모두 실행되었거나 해제되어 있어야 한다
    const pendingDelays = tracker.timers
      .filter((timer) => !timer.fired && !timer.cleared && timer.handle.hasRef())
      .map((timer) => timer.delayMs);
    expect(pendingDelays).toEqual([]);
  });
});
