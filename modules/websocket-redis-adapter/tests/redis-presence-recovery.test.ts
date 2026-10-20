import { WebSocketAudience } from "sonamu";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createRedisWebSocketAdapter, type RedisWebSocketAdapter } from "../src/index";
import {
  createRawClient,
  eventually,
  nodeKeys,
  type RawRedisClient,
  type StartedRedis,
  startRedis,
  uniqueName,
} from "./helpers/redis-container";
import { shutdownAdapters } from "./helpers/runtime-harness";
import { hashFields, registerSession } from "./helpers/store-helpers";

describe("Redis 노드 키 유실 복구", () => {
  let redis: StartedRedis;
  let raw: RawRedisClient;
  const adapters: RedisWebSocketAdapter[] = [];

  function createAdapter(
    options: Partial<Parameters<typeof createRedisWebSocketAdapter>[0]> & {
      prefix: string;
      nodeId: string;
    },
  ): RedisWebSocketAdapter {
    const adapter = createRedisWebSocketAdapter({ redis: { url: redis.url }, ...options });
    adapters.push(adapter);
    return adapter;
  }

  beforeAll(async () => {
    redis = await startRedis();
    raw = await createRawClient(redis.url);
  });

  afterEach(async () => {
    await shutdownAdapters(adapters);
  });

  afterAll(async () => {
    await raw?.close().catch(() => {});
    await redis?.stop();
  });

  describe("명령 실패 없이 노드 키가 사라진 경우", () => {
    it("연결이 유지되고 명령 실패가 없는데 노드 키가 지워져도(eviction/FLUSH) 몇 번의 heartbeat 안에 메모리 상태로 복구한다", async () => {
      const prefix = uniqueName("keys-evicted");
      const nodeA = uniqueName("node-a");
      const nodeB = uniqueName("node-b");
      const keysB = nodeKeys(prefix, nodeB);
      const options = {
        heartbeatIntervalMs: 200,
        nodeTimeoutMs: 1_000,
        keyTtlMs: 2_000,
        commandDeadlineMs: 1_000,
        readyTimeoutMs: 1_000,
        drainTimeoutMs: 500,
      };
      const storeA = createAdapter({ prefix, nodeId: nodeA, ...options }).presenceStore;
      const storeB = createAdapter({ prefix, nodeId: nodeB, ...options }).presenceStore;
      await registerSession(storeA, { sessionId: "a-1", nodeId: nodeA });
      await registerSession(storeB, { sessionId: "b-1", nodeId: nodeB });
      await storeB.join("b-1", "room-1");
      await storeB.setUserId("b-1", 7);
      expect(
        (await storeA.resolveRoute(WebSocketAudience.room("room-1", "chat"), nodeA)).remoteNodeIds,
      ).toEqual([nodeB]);

      // Redis 명령은 하나도 실패하지 않은 채 키만 사라진다
      await raw.del([keysB.sessions, keysB.rooms, keysB.users, keysB.namespaces]);
      expect(storeB.getStatus()).toEqual({ ready: true, rebuildPending: false });

      // heartbeat 주기(200ms)의 몇 배 안에 복구되어야 한다
      await eventually(
        async () => {
          expect(await raw.hKeys(keysB.sessions)).toEqual(["b-1"]);
          expect(Object.values(await hashFields(raw, keysB.rooms))).toEqual(["1"]);
          expect(Object.values(await hashFields(raw, keysB.users))).toEqual(["1"]);
          expect(await raw.hGet(keysB.namespaces, "chat")).toBe("1");
          expect(
            (await storeA.resolveRoute(WebSocketAudience.room("room-1", "chat"), nodeA))
              .remoteNodeIds,
          ).toEqual([nodeB]);
          expect(await storeA.getRoomMemberCount("room-1", "chat")).toBe(1);
        },
        { timeoutMs: 2_000, intervalMs: 50 },
      );
      expect(storeB.getStatus()).toEqual({ ready: true, rebuildPending: false });
    });
  });
});
