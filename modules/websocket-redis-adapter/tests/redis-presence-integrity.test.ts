import { createClient } from "redis";
import { WebSocketAudience } from "sonamu";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createRedisWebSocketAdapter, type RedisWebSocketAdapter } from "../src/index";
import {
  clientAddressOf,
  createRawClient,
  eventually,
  listClients,
  nodeKeys,
  type RawRedisClient,
  settleWithin,
  sleep,
  type StartedRedis,
  startMonitor,
  startRedis,
  startSilentTcpServer,
  uniqueName,
} from "./helpers/redis-container";
import { shutdownAdapters } from "./helpers/runtime-harness";
import { createGate, hashFields, registerSession } from "./helpers/store-helpers";
import { pendingRefTimerDelays, trackTimeouts } from "./helpers/timer-tracker";

type AdapterOptions = Parameters<typeof createRedisWebSocketAdapter>[0];

// heartbeat가 검증 구간에 끼어들지 않도록 아주 긴 주기를 쓴다
const QUIET_HEARTBEAT_OPTIONS = {
  heartbeatIntervalMs: 600_000,
  nodeTimeoutMs: 1_800_000,
  keyTtlMs: 3_600_000,
  commandDeadlineMs: 2_000,
  readyTimeoutMs: 2_000,
  drainTimeoutMs: 1_000,
};

// 키 유실을 몇 번의 heartbeat 안에 알아채는지 보기 위한 짧은 주기
const FAST_HEARTBEAT_OPTIONS = {
  heartbeatIntervalMs: 200,
  nodeTimeoutMs: 2_000,
  keyTtlMs: 4_000,
  commandDeadlineMs: 1_000,
  readyTimeoutMs: 1_000,
  drainTimeoutMs: 500,
};

describe("노드 키 무결성과 room 인원수", () => {
  let redis: StartedRedis;
  let raw: RawRedisClient;
  const adapters: RedisWebSocketAdapter[] = [];
  const callers: RawRedisClient[] = [];

  function createAdapter(
    options: Partial<AdapterOptions> & { prefix: string; nodeId: string },
  ): RedisWebSocketAdapter {
    const adapter = createRedisWebSocketAdapter({ redis: { url: redis.url }, ...options });
    adapters.push(adapter);
    return adapter;
  }

  // 어댑터 명령 client를 테스트가 감싸거나 MONITOR에서 구분할 수 있도록 호출자 소유 client를 쓴다
  async function connectedCaller(): Promise<RawRedisClient> {
    const caller = createClient({ url: redis.url });
    caller.on("error", () => {});
    await caller.connect();
    callers.push(caller);
    return caller;
  }

  beforeAll(async () => {
    redis = await startRedis();
    raw = await createRawClient(redis.url);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownAdapters(adapters);
    for (const caller of callers.splice(0)) {
      await caller.close().catch(() => {});
    }
  });

  afterAll(async () => {
    await raw?.close().catch(() => {});
    await redis?.stop();
  });

  describe("count 해시 하나만 사라진 경우의 복구", () => {
    it.each(["rooms", "users", "namespaces"] as const)(
      "명령 실패 없이 %s 해시만 지워져도 몇 번의 heartbeat 안에 메모리 상태로 복구되고 원격 노드가 다시 본다",
      async (lostHash) => {
        const prefix = uniqueName(`lost-${lostHash}`);
        const nodeA = uniqueName("node-a");
        const nodeB = uniqueName("node-b");
        const keysB = nodeKeys(prefix, nodeB);
        const storeA = createAdapter({
          prefix,
          nodeId: nodeA,
          ...FAST_HEARTBEAT_OPTIONS,
        }).presenceStore;
        const storeB = createAdapter({
          prefix,
          nodeId: nodeB,
          ...FAST_HEARTBEAT_OPTIONS,
        }).presenceStore;
        await registerSession(storeA, { sessionId: "a-1", nodeId: nodeA });
        // 방·사용자·활성 namespace를 모두 가진 활성 세션
        await registerSession(storeB, { sessionId: "b-1", nodeId: nodeB });
        await storeB.join("b-1", "room-1");
        await storeB.setUserId("b-1", 7);

        const expectNodeBVisible = async () => {
          expect(await raw.hKeys(keysB.sessions)).toEqual(["b-1"]);
          expect(Object.values(await hashFields(raw, keysB.rooms))).toEqual(["1"]);
          expect(Object.values(await hashFields(raw, keysB.users))).toEqual(["1"]);
          expect(await raw.hGet(keysB.namespaces, "chat")).toBe("1");
          const remoteOf = async (audience: WebSocketAudience) =>
            (await storeA.resolveRoute(audience, nodeA)).remoteNodeIds;
          expect(await remoteOf(WebSocketAudience.room("room-1", "chat"))).toEqual([nodeB]);
          expect(await remoteOf(WebSocketAudience.user(7, "chat"))).toEqual([nodeB]);
          expect(await remoteOf(WebSocketAudience.all("chat"))).toEqual([nodeB]);
          // namespace 없는 room 조회는 namespaces 해시로 펼치므로 세 해시가 모두 있어야 맞다
          expect(await remoteOf(WebSocketAudience.room("room-1"))).toEqual([nodeB]);
          expect(await storeA.getRoomMemberCount("room-1", "chat")).toBe(1);
          expect(await storeA.getRoomMemberCount("room-1")).toBe(1);
        };
        // 전제: 지우기 전에는 원격 노드 A가 B를 본다
        await expectNodeBVisible();

        // 연결과 명령은 정상인 채 해시 하나만 사라진다 (eviction 정책은 키를 하나씩 지운다)
        await raw.del(keysB[lostHash]);
        expect(await raw.exists(keysB.sessions)).toBe(1);
        expect(storeB.getStatus()).toEqual({ ready: true, rebuildPending: false });

        // heartbeat 주기(200ms)의 몇 배 안에 복구되어야 한다
        await eventually(expectNodeBVisible, { timeoutMs: 2_000, intervalMs: 50 });
        await eventually(() => {
          expect(storeB.getStatus()).toEqual({ ready: true, rebuildPending: false });
        });
      },
    );

    it("메모리상 방·사용자가 없어 rooms/users 해시가 없는 것은 정상이므로 heartbeat가 rebuild하지 않는다", async () => {
      const prefix = uniqueName("legit-absent");
      const nodeId = uniqueName("node");
      const keys = nodeKeys(prefix, nodeId);
      const caller = await connectedCaller();
      const monitor = await startMonitor(redis.url);
      try {
        const store = createAdapter({
          prefix,
          nodeId,
          redis: caller,
          ...FAST_HEARTBEAT_OPTIONS,
          heartbeatIntervalMs: 100,
        }).presenceStore;
        // 활성 세션에는 방도 userId도 없다
        await registerSession(store, { sessionId: "s1", nodeId });
        await registerSession(store, { sessionId: "s2", nodeId, namespace: "admin" });
        // 비활성 세션의 방과 userId는 count 해시에 기여하지 않는다
        await registerSession(store, { sessionId: "s-inactive", nodeId, active: false });
        await store.join("s-inactive", "room-1");
        await store.setUserId("s-inactive", 9);
        await sleep(300);

        // 전제: rooms/users 해시는 없고 sessions/namespaces 해시는 있다
        expect(await raw.exists([keys.rooms, keys.users])).toBe(0);
        expect(await raw.exists([keys.sessions, keys.namespaces])).toBe(2);

        const adapterAddress = await clientAddressOf(caller);
        const commands = await monitor.capture(async () => {
          // heartbeat 약 12번
          await sleep(1_200);
        });
        const sentByAdapter = commands.filter((entry) => entry.source === adapterAddress);

        // heartbeat는 실제로 여러 번 돌았다
        expect(
          sentByAdapter.filter((entry) => entry.command === "zadd").length,
        ).toBeGreaterThanOrEqual(5);
        // 그런데도 rebuild(EVALSHA)는 한 번도 보내지 않는다
        expect(sentByAdapter.filter((entry) => entry.command === "evalsha")).toEqual([]);
        expect(store.getStatus()).toEqual({ ready: true, rebuildPending: false });
      } finally {
        await monitor.close();
      }
    });
  });

  it("rebuild 스크립트 직후 노드 키가 사라지면 다음 정기 heartbeat를 기다리지 않고 다시 rebuild해 복구한다", async () => {
    const prefix = uniqueName("rebuild-heartbeat-result");
    const nodeId = uniqueName("node");
    const keys = nodeKeys(prefix, nodeId);
    const caller = await connectedCaller();
    const heartbeatIntervalMs = 3_000;
    const store = createAdapter({
      prefix,
      nodeId,
      redis: caller,
      ...QUIET_HEARTBEAT_OPTIONS,
      heartbeatIntervalMs,
      nodeTimeoutMs: 10_000,
      keyTtlMs: 20_000,
    }).presenceStore;
    await registerSession(store, { sessionId: "s1", nodeId });
    await store.join("s1", "room-1");

    /**
     * 1번째 EVALSHA(join room-2)는 실패시켜 rebuild 대기를 만든다.
     * 그 뒤의 EVALSHA는 모두 heartbeat가 예약한 rebuild다(처음 쓰는 스크립트라 NOSCRIPT 뒤 재시도가 있을 수 있다).
     * 처음으로 성공한 rebuild 스크립트 직후, rebuild가 heartbeat를 보내기 전에 노드 키를 지운다.
     */
    const rebuildDone = createGate();
    let deletedOnce = false;
    const originalEvalSha = caller.evalSha.bind(caller);
    vi.spyOn(caller, "evalSha")
      .mockRejectedValueOnce(new Error("테스트용 쓰기 실패"))
      .mockImplementation(async (sha, options) => {
        const reply = await originalEvalSha(sha, options);
        if (!deletedOnce) {
          deletedOnce = true;
          await raw.del([keys.sessions, keys.rooms, keys.users, keys.namespaces]);
          rebuildDone.markReached();
        }
        return reply;
      });
    await store.join("s1", "room-2").catch(() => {});
    expect(store.getStatus().rebuildPending).toBe(true);

    expect(await settleWithin(rebuildDone.reached, heartbeatIntervalMs + 3_000)).toBe("fulfilled");
    const deletedAt = Date.now();

    // rebuild 직후 heartbeat가 키 유실을 알렸으므로, 다음 정기 heartbeat(약 3초 뒤)보다 훨씬 먼저 복구되어야 한다
    await eventually(
      async () => {
        expect(await raw.hKeys(keys.sessions)).toEqual(["s1"]);
        expect(Object.values(await hashFields(raw, keys.rooms))).toEqual(["1", "1"]);
        expect(await raw.hGet(keys.namespaces, "chat")).toBe("1");
      },
      { timeoutMs: 1_500, intervalMs: 50 },
    );
    expect(Date.now() - deletedAt).toBeLessThan(heartbeatIntervalMs - 1_000);
    await eventually(() => {
      expect(store.getStatus()).toEqual({ ready: true, rebuildPending: false });
    });
  });

  describe("rebuild 대기 중의 room 인원수", () => {
    it("Redis에 반영되지 않은 자기 노드 join도 메모리에서 세고, 원격 노드 인원은 Redis에서 센다 (namespace 생략과 빈 문자열 포함)", async () => {
      const prefix = uniqueName("count-pending");
      const nodeA = uniqueName("node-a");
      const nodeB = uniqueName("node-b");
      const keysB = nodeKeys(prefix, nodeB);
      const caller = await connectedCaller();
      const storeA = createAdapter({
        prefix,
        nodeId: nodeA,
        ...QUIET_HEARTBEAT_OPTIONS,
      }).presenceStore;
      const storeB = createAdapter({
        prefix,
        nodeId: nodeB,
        redis: caller,
        ...QUIET_HEARTBEAT_OPTIONS,
      }).presenceStore;
      await registerSession(storeA, { sessionId: "a-1", nodeId: nodeA });
      await storeA.join("a-1", "room-1");
      await registerSession(storeB, { sessionId: "b-1", nodeId: nodeB });
      await registerSession(storeB, { sessionId: "b-admin", nodeId: nodeB, namespace: "admin" });
      await registerSession(storeB, { sessionId: "b-inactive", nodeId: nodeB, active: false });
      await registerSession(storeB, { sessionId: "b-2", nodeId: nodeB });
      await storeB.join("b-1", "room-1");
      await storeB.join("b-admin", "room-1");
      await storeB.join("b-inactive", "room-1");

      // b-2의 join은 Redis 쓰기에 실패해 메모리에만 반영된다
      vi.spyOn(caller, "evalSha").mockRejectedValueOnce(new Error("테스트용 쓰기 실패"));
      await storeB.join("b-2", "room-1").catch(() => {});
      expect(storeB.getStatus().rebuildPending).toBe(true);
      // 전제: Redis의 노드 B room-1 count는 chat 1(b-1), admin 1(b-admin)뿐이다
      expect(Object.values(await hashFields(raw, keysB.rooms)).toSorted()).toEqual(["1", "1"]);

      // 노드 B: 메모리의 활성 멤버 + Redis의 원격 노드 A
      expect(await storeB.getRoomMemberCount("room-1", "chat")).toBe(2 + 1);
      expect(await storeB.getRoomMemberCount("room-1", "admin")).toBe(1);
      expect(await storeB.getRoomMemberCount("room-1", "")).toBe(3 + 1);
      expect(await storeB.getRoomMemberCount("room-1")).toBe(3 + 1);
      // 노드 A: 자기 메모리 1 + 노드 B는 Redis 기준(b-1, b-admin)
      expect(await storeA.getRoomMemberCount("room-1", "chat")).toBe(1 + 1);
      expect(await storeA.getRoomMemberCount("room-1", "")).toBe(1 + 2);
      expect(storeB.getStatus().rebuildPending).toBe(true);
    });

    it("자기 노드 rooms 해시가 사라져도 자기 노드 인원은 메모리에서 세고, 원격 노드는 Redis 값을 쓴다", async () => {
      const prefix = uniqueName("count-lost-rooms");
      const nodeA = uniqueName("node-a");
      const nodeB = uniqueName("node-b");
      const keysB = nodeKeys(prefix, nodeB);
      const storeA = createAdapter({
        prefix,
        nodeId: nodeA,
        ...QUIET_HEARTBEAT_OPTIONS,
      }).presenceStore;
      const storeB = createAdapter({
        prefix,
        nodeId: nodeB,
        ...QUIET_HEARTBEAT_OPTIONS,
      }).presenceStore;
      await registerSession(storeA, { sessionId: "a-1", nodeId: nodeA });
      await storeA.join("a-1", "room-1");
      await registerSession(storeB, { sessionId: "b-1", nodeId: nodeB });
      await registerSession(storeB, { sessionId: "b-2", nodeId: nodeB });
      await storeB.join("b-1", "room-1");
      await storeB.join("b-2", "room-1");

      // heartbeat가 오래 돌지 않으므로 유실이 복구되지 않은 상태가 유지된다
      await raw.del(keysB.rooms);

      expect(await storeB.getRoomMemberCount("room-1", "chat")).toBe(2 + 1);
      expect(await storeB.getRoomMemberCount("room-1", "")).toBe(2 + 1);
      // 노드 A가 보는 노드 B 인원은 Redis 값(유실로 0)이다
      expect(await storeA.getRoomMemberCount("room-1", "chat")).toBe(1);
    });
  });

  describe("shutdown 뒤의 읽기", () => {
    it("연결을 시작한 적 없는 store를 shutdown한 뒤 읽기를 호출해도 Redis에 새로 연결하지 않는다", async () => {
      const prefix = uniqueName("read-after-shutdown");
      const nodeId = uniqueName("node");
      const baseline = (await listClients(raw)).length;
      // bus는 shutdown하지 않아 연결의 다른 소유자는 남아 있다
      const adapter = createAdapter({ prefix, nodeId, ...FAST_HEARTBEAT_OPTIONS });

      await adapter.presenceStore.shutdown();
      await settleWithin(
        Promise.resolve(
          adapter.presenceStore.resolveRoute(WebSocketAudience.room("room-1", "chat"), nodeId),
        ),
        2_000,
      );
      await settleWithin(
        Promise.resolve(adapter.presenceStore.getRoomMemberCount("room-1", "chat")),
        2_000,
      );
      await sleep(300);

      expect((await listClients(raw)).length).toBe(baseline);
    });

    it("연결을 시작한 적 없는 store를 shutdown한 뒤 읽기를 호출해도 연결을 열거나 event loop를 붙잡는 타이머를 남기지 않는다", async () => {
      // 응답하지 않는 서버: 연결을 시작하면 readyTimeoutMs 동안 ready를 기다리게 된다
      const silent = await startSilentTcpServer();
      try {
        const prefix = uniqueName("read-after-shutdown-silent");
        const nodeId = uniqueName("node");
        const adapter = createRedisWebSocketAdapter({
          redis: { url: silent.url },
          prefix,
          nodeId,
          ...FAST_HEARTBEAT_OPTIONS,
          readyTimeoutMs: 5_000,
        });
        adapters.push(adapter);
        await adapter.presenceStore.shutdown();

        const tracker = trackTimeouts();
        const reads = Promise.allSettled([
          Promise.resolve(
            adapter.presenceStore.resolveRoute(WebSocketAudience.room("room-1", "chat"), nodeId),
          ),
          Promise.resolve(adapter.presenceStore.getRoomMemberCount("room-1", "chat")),
        ]);
        await settleWithin(reads, 300);
        tracker.stop();

        expect(silent.acceptedCount()).toBe(0);
        expect(pendingRefTimerDelays(tracker)).toEqual([]);
        // 읽기는 readyTimeoutMs를 기다리지 않고 바로 끝난다
        expect(await settleWithin(reads, 0)).toBe("fulfilled");
      } finally {
        await shutdownAdapters(adapters);
        await silent.close();
      }
    });
  });
});
