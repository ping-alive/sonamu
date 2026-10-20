import { hostname } from "node:os";

import { createClient, type RedisClientType } from "redis";
import { createWebSocketNodeId, WebSocketAudience } from "sonamu";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createRedisWebSocketAdapter, type RedisWebSocketAdapter } from "../src/index";
import {
  createRawClient,
  eventually,
  killOtherClients,
  listClients,
  nodeKeys,
  type RawRedisClient,
  settleWithin,
  sleep,
  type StartedRedis,
  startRedis,
  startSilentTcpServer,
  timeSettle,
  uniqueName,
} from "./helpers/redis-container";
import { FAST_ADAPTER_OPTIONS, shutdownAdapters } from "./helpers/runtime-harness";
import { registerSession } from "./helpers/store-helpers";

const DEFAULT_PREFIX = "sonamu:ws";

describe("어댑터 수명주기와 소유권", () => {
  let redis: StartedRedis;
  let raw: RawRedisClient;
  const adapters: RedisWebSocketAdapter[] = [];

  function track(adapter: RedisWebSocketAdapter): RedisWebSocketAdapter {
    adapters.push(adapter);
    return adapter;
  }

  async function clientCount(): Promise<number> {
    return (await listClients(raw)).length;
  }

  // 호출자 client의 duplicate()가 만든 연결을 가로채 기록한다
  type DuplicatedClient = ReturnType<RedisClientType["duplicate"]>;

  function recordDuplicates(client: RedisClientType): DuplicatedClient[] {
    const duplicates: DuplicatedClient[] = [];
    const original = client.duplicate.bind(client);
    vi.spyOn(client, "duplicate").mockImplementation(
      (...args: Parameters<RedisClientType["duplicate"]>) => {
        const duplicate = original(...args);
        duplicates.push(duplicate);
        return duplicate;
      },
    );
    return duplicates;
  }

  beforeAll(async () => {
    redis = await startRedis();
    raw = await createRawClient(redis.url);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await redis.ensureUnpaused();
    await shutdownAdapters(adapters);
  });

  afterAll(async () => {
    await raw?.close().catch(() => {});
    await redis?.stop();
  });

  describe("연결 옵션 입력 (어댑터 소유)", () => {
    it("생성만으로는 연결하지 않고 첫 사용 때 lazy connect하며, shutdown에서 자기 연결을 모두 닫는다", async () => {
      const baseline = await clientCount();
      const nodeId = uniqueName("lazy");
      const adapter = track(
        createRedisWebSocketAdapter({
          redis: { url: redis.url },
          prefix: uniqueName("lazy"),
          nodeId,
          ...FAST_ADAPTER_OPTIONS,
        }),
      );

      await sleep(300);
      expect(await clientCount()).toBe(baseline);
      expect(adapter.presenceStore.getStatus()).toEqual({ ready: false, rebuildPending: false });

      await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });
      await adapter.clusterBus.subscribe(() => {});

      expect(adapter.presenceStore.getStatus().ready).toBe(true);
      expect(await clientCount()).toBeGreaterThan(baseline);

      await adapter.presenceStore.shutdown();
      await adapter.clusterBus.shutdown();

      await eventually(async () => {
        expect(await clientCount()).toBe(baseline);
      });
    });

    it("어댑터가 만든 모든 client에 error 리스너가 있어 연결이 끊겨도 프로세스가 죽지 않고 복구된다", async () => {
      const uncaught: Error[] = [];
      const onUncaught = (error: Error) => {
        uncaught.push(error);
      };
      process.on("uncaughtException", onUncaught);
      process.on("unhandledRejection", onUncaught);
      try {
        const prefix = uniqueName("error-listener");
        const nodeId = uniqueName("node");
        const adapter = track(
          createRedisWebSocketAdapter({
            redis: { url: redis.url },
            prefix,
            nodeId,
            ...FAST_ADAPTER_OPTIONS,
          }),
        );
        await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });
        await adapter.clusterBus.subscribe(() => {});

        expect(await killOtherClients(raw)).toBeGreaterThanOrEqual(2);

        await eventually(
          async () => {
            expect(adapter.presenceStore.getStatus().ready).toBe(true);
            await adapter.presenceStore.join("s1", "room-after-error");
            expect(await adapter.presenceStore.getRoomMemberCount("room-after-error", "chat")).toBe(
              1,
            );
          },
          { timeoutMs: 10_000, intervalMs: 200 },
        );
        expect(uncaught).toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onUncaught);
      }
    });
  });

  describe("RedisClient 입력 (호출자 소유)", () => {
    it("pub/sub용 duplicate() 하나만 만들어 소유하고, shutdown 뒤 호출자 client는 열린 채로 남는다", async () => {
      const caller: RedisClientType = createClient({ url: redis.url });
      caller.on("error", () => {});
      await caller.connect();
      try {
        const baseline = await clientCount();
        const duplicates = recordDuplicates(caller);
        const nodeId = uniqueName("caller");
        const adapter = track(
          createRedisWebSocketAdapter({
            redis: caller,
            prefix: uniqueName("caller"),
            nodeId,
            ...FAST_ADAPTER_OPTIONS,
          }),
        );

        await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });
        await adapter.clusterBus.subscribe(() => {});

        expect(duplicates).toHaveLength(1);
        expect(duplicates[0].listenerCount("error")).toBeGreaterThanOrEqual(1);
        expect(duplicates[0].isOpen).toBe(true);
        expect(await clientCount()).toBe(baseline + 1);

        await adapter.presenceStore.shutdown();
        await adapter.clusterBus.shutdown();

        expect(caller.isOpen).toBe(true);
        expect(await caller.ping()).toBe("PONG");
        expect(duplicates[0].isOpen).toBe(false);
        await eventually(async () => {
          expect(await clientCount()).toBe(baseline);
        });
      } finally {
        await caller.close().catch(() => {});
      }
    });

    it("연결되지 않은 호출자 client는 어댑터가 연결하지 않고, 등록은 readyTimeoutMs 안에 로컬 전용으로 끝난다", async () => {
      const caller: RedisClientType = createClient({ url: redis.url });
      caller.on("error", () => {});
      const nodeId = uniqueName("unconnected");
      const adapter = track(
        createRedisWebSocketAdapter({
          redis: caller,
          prefix: uniqueName("unconnected"),
          nodeId,
          ...FAST_ADAPTER_OPTIONS,
          readyTimeoutMs: 500,
          commandDeadlineMs: 500,
        }),
      );

      const registered = await timeSettle(
        registerSession(adapter.presenceStore, { sessionId: "s1", nodeId }),
      );
      expect(registered.elapsedMs).toBeLessThan(500 + 500 + 1_500);
      await settleWithin(
        Promise.resolve().then(() => adapter.clusterBus.subscribe(() => {})),
        3_000,
      );

      expect(caller.isOpen).toBe(false);
      expect(adapter.presenceStore.getStatus()).toEqual({ ready: false, rebuildPending: true });

      await shutdownAdapters(adapters);
      expect(caller.isOpen).toBe(false);
    });
  });

  describe("기본값", () => {
    it("nodeId 기본값은 createWebSocketNodeId()와 같은 hostname-pid-랜덤 형식이고 어댑터마다 다르다", () => {
      const first = track(createRedisWebSocketAdapter({ redis: { url: redis.url } }));
      const second = track(createRedisWebSocketAdapter({ redis: { url: redis.url } }));
      const reference = createWebSocketNodeId();
      const expectedHead = `${hostname()}-${process.pid}-`;

      expect(reference.startsWith(expectedHead)).toBe(true);
      expect(first.nodeId.startsWith(expectedHead)).toBe(true);
      expect(first.nodeId.length).toBe(reference.length);
      expect(second.nodeId).not.toBe(first.nodeId);
      expect(first.presenceStore.nodeId).toBe(first.nodeId);
      expect(first.clusterBus.nodeId).toBe(first.nodeId);
    });

    it("prefix 기본값은 sonamu:ws이고 keyTtlMs 기본값은 30000이다", async () => {
      const nodeId = uniqueName("defaults");
      const adapter = track(createRedisWebSocketAdapter({ redis: { url: redis.url }, nodeId }));
      const keys = nodeKeys(DEFAULT_PREFIX, nodeId);

      await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });
      await adapter.presenceStore.join("s1", "room-1");
      await adapter.clusterBus.subscribe(() => {});

      expect(await raw.exists(keys.sessions)).toBe(1);
      expect(await raw.zScore(keys.nodes, nodeId)).not.toBeNull();
      const ttl = await raw.pTTL(keys.sessions);
      expect(ttl).toBeGreaterThan(20_000);
      expect(ttl).toBeLessThanOrEqual(30_000);
      const channels = await raw.pubSubChannels(`*${nodeId}*`);
      expect(channels).toHaveLength(1);
      expect(channels[0].startsWith(`${DEFAULT_PREFIX}:`)).toBe(true);
    });

    it("heartbeatIntervalMs 기본값은 5000이다", async () => {
      const nodeId = uniqueName("default-heartbeat");
      const adapter = track(createRedisWebSocketAdapter({ redis: { url: redis.url }, nodeId }));
      const keys = nodeKeys(DEFAULT_PREFIX, nodeId);
      await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });

      const readScore = async () => Number(await raw.zScore(keys.nodes, nodeId));
      const initial = await readScore();
      let first = initial;
      await eventually(
        async () => {
          first = await readScore();
          expect(first).toBeGreaterThan(initial);
        },
        { timeoutMs: 8_000, intervalMs: 100 },
      );
      let second = first;
      await eventually(
        async () => {
          second = await readScore();
          expect(second).toBeGreaterThan(first);
        },
        { timeoutMs: 8_000, intervalMs: 100 },
      );

      expect(second - first).toBeGreaterThanOrEqual(4_000);
      expect(second - first).toBeLessThanOrEqual(6_500);
    });

    it("nodeTimeoutMs 기본값은 15000이라 15초보다 오래된 노드는 라우팅에서 빠진다", async () => {
      const nodeId = uniqueName("default-timeout");
      const adapter = track(createRedisWebSocketAdapter({ redis: { url: redis.url }, nodeId }));
      const freshNode = uniqueName("fresh-node");
      const staleNode = uniqueName("stale-node");
      const nodesKey = nodeKeys(DEFAULT_PREFIX, nodeId).nodes;
      await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });

      const now = Date.now();
      await raw.zAdd(nodesKey, [
        { score: now - 11_000, value: freshNode },
        { score: now - 17_000, value: staleNode },
      ]);
      await raw.hSet(nodeKeys(DEFAULT_PREFIX, freshNode).namespaces, "chat", "1");
      await raw.hSet(nodeKeys(DEFAULT_PREFIX, staleNode).namespaces, "chat", "1");
      try {
        const plan = await adapter.presenceStore.resolveRoute(
          WebSocketAudience.all("chat"),
          nodeId,
        );
        expect(plan.remoteNodeIds).toContain(freshNode);
        expect(plan.remoteNodeIds).not.toContain(staleNode);
      } finally {
        await raw.zRem(nodesKey, [freshNode, staleNode]);
        await raw.del([
          nodeKeys(DEFAULT_PREFIX, freshNode).namespaces,
          nodeKeys(DEFAULT_PREFIX, staleNode).namespaces,
        ]);
      }
    });

    it("commandDeadlineMs 기본값은 2000이다", async () => {
      const nodeId = uniqueName("default-deadline");
      const adapter = track(createRedisWebSocketAdapter({ redis: { url: redis.url }, nodeId }));
      await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });

      await redis.pause();
      const read = await timeSettle(
        Promise.resolve(adapter.presenceStore.getRoomMemberCount("room-1", "chat")),
      );
      await redis.unpause();

      expect(read.elapsedMs).toBeGreaterThanOrEqual(1_500);
      expect(read.elapsedMs).toBeLessThan(3_500);
    });

    it("readyTimeoutMs 기본값은 3000이다", async () => {
      const silent = await startSilentTcpServer();
      try {
        const nodeId = uniqueName("default-ready");
        const adapter = track(createRedisWebSocketAdapter({ redis: { url: silent.url }, nodeId }));

        const registered = await timeSettle(
          registerSession(adapter.presenceStore, { sessionId: "s1", nodeId }),
        );

        expect(registered.elapsedMs).toBeGreaterThanOrEqual(2_500);
        expect(registered.elapsedMs).toBeLessThan(3_000 + 2_000 + 1_000);
        expect(adapter.presenceStore.getStatus()).toEqual({ ready: false, rebuildPending: true });
        await shutdownAdapters(adapters);
      } finally {
        await silent.close();
      }
    });

    it("drainTimeoutMs 기본값(5000) 안에서 Redis가 멈춰 있어도 shutdown이 끝난다", async () => {
      const nodeId = uniqueName("default-drain");
      const adapter = track(createRedisWebSocketAdapter({ redis: { url: redis.url }, nodeId }));
      await registerSession(adapter.presenceStore, { sessionId: "s1", nodeId });

      await redis.pause();
      void Promise.resolve(adapter.presenceStore.join("s1", "room-1")).catch(() => {});
      const shutdown = await timeSettle(Promise.resolve(adapter.presenceStore.shutdown()));
      await redis.unpause();

      expect(shutdown.status).toBe("fulfilled");
      // drain 5000 + 키 삭제 deadline 2000 + 여유
      expect(shutdown.elapsedMs).toBeLessThan(9_000);
    });
  });

  describe("ready 전 shutdown 정리", () => {
    it("ready 전에 drain timeout으로 shutdown하면, ready를 기다리던 mutation과 heartbeat가 shutdown 뒤 Redis에 쓰이지 않는다", async () => {
      // 아직 연결되지 않은 호출자 client: 어댑터는 연결하지 않고 ready를 readyTimeoutMs까지 기다린다
      const caller: RedisClientType = createClient({ url: redis.url });
      caller.on("error", () => {});
      const prefix = uniqueName("shutdown-before-ready");
      const nodeId = uniqueName("node");
      const keys = nodeKeys(prefix, nodeId);
      try {
        const adapter = track(
          createRedisWebSocketAdapter({
            redis: caller,
            prefix,
            nodeId,
            heartbeatIntervalMs: 200,
            nodeTimeoutMs: 2_000,
            keyTtlMs: 10_000,
            commandDeadlineMs: 1_000,
            readyTimeoutMs: 5_000,
            // readyTimeoutMs보다 짧다
            drainTimeoutMs: 200,
          }),
        );
        const store = adapter.presenceStore;
        const registering = registerSession(store, { sessionId: "s1", nodeId });
        const joining = store.join("s1", "room-1");
        const settingUser = store.setUserId("s1", 1);

        const shutdown = await timeSettle(store.shutdown());
        expect(shutdown.status).toBe("fulfilled");
        // readyTimeoutMs를 기다리지 않고 drain timeout 뒤에 끝난다
        expect(shutdown.elapsedMs).toBeLessThan(3_000);

        // shutdown이 끝난 뒤 호출자가 client를 연결해 ready가 된다
        await caller.connect();
        await settleWithin(Promise.allSettled([registering, joining, settingUser]), 6_000);

        // heartbeat 주기 여러 번 동안 노드 키, nodes 멤버, heartbeat가 다시 생기지 않는지 관찰한다
        for (let round = 0; round < 6; round += 1) {
          expect(
            await raw.exists([keys.sessions, keys.rooms, keys.users, keys.namespaces]),
            `round ${round}`,
          ).toBe(0);
          expect(await raw.zScore(keys.nodes, nodeId), `round ${round}`).toBeNull();
          await sleep(200);
        }
      } finally {
        await shutdownAdapters(adapters);
        if (caller.isOpen) {
          await caller.close().catch(() => {});
        }
      }
    });
  });
});
