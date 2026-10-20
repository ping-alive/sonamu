import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { framesOf } from "./helpers/fake-socket";
import {
  createRawClient,
  eventually,
  killOtherClients,
  nodeKeys,
  type RawRedisClient,
  sleep,
  type StartedRedis,
  startRedis,
  startSilentTcpServer,
  timeSettle,
  uniqueName,
} from "./helpers/redis-container";
import {
  createTestNode,
  FAST_ADAPTER_OPTIONS,
  shutdownAll,
  type TestNode,
} from "./helpers/runtime-harness";
import { hashFields, readSession } from "./helpers/store-helpers";

// 데이터 모델 형식을 따르는 가짜 고스트 세션. rebuild가 이 엔트리를 지워야 한다
const GHOST_SESSION_JSON = JSON.stringify({
  sessionId: "ghost-session",
  namespace: "chat",
  active: true,
  rooms: ["room-ghost"],
  connectedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_000_000,
});

describe("Redis 장애 대응", () => {
  let redis: StartedRedis;
  let raw: RawRedisClient;
  const nodes: TestNode[] = [];

  function startNode(
    prefix: string,
    adapterOverrides: Partial<Parameters<typeof createTestNode>[0]["adapterOptions"]> = {},
    url: string = redis.url,
  ): TestNode {
    const node = createTestNode({
      adapterOptions: {
        redis: { url },
        prefix,
        nodeId: uniqueName("node"),
        ...FAST_ADAPTER_OPTIONS,
        ...adapterOverrides,
      },
    });
    nodes.push(node);
    return node;
  }

  // rebuild 외에는 고칠 수 없는 불일치를 만든다: 실제 세션을 지우고 고스트 엔트리를 넣는다
  async function corruptNodeKeys(
    prefix: string,
    nodeId: string,
    removeSessionId: string,
  ): Promise<void> {
    const keys = nodeKeys(prefix, nodeId);
    await raw.hDel(keys.sessions, removeSessionId);
    await raw.hSet(keys.sessions, "ghost-session", GHOST_SESSION_JSON);
    await raw.hSet(keys.rooms, "ghost-room-field", "5");
    await raw.hSet(keys.users, "ghost-user-field", "3");
  }

  async function expectNodeKeysMatchMemory(
    prefix: string,
    nodeId: string,
    sessionIds: string[],
    rooms: Record<string, string[]>,
  ): Promise<void> {
    const keys = nodeKeys(prefix, nodeId);
    expect((await raw.hKeys(keys.sessions)).toSorted()).toEqual([...sessionIds].toSorted());
    expect(Object.keys(await hashFields(raw, keys.rooms))).not.toContain("ghost-room-field");
    expect(Object.keys(await hashFields(raw, keys.users))).not.toContain("ghost-user-field");
    expect(await raw.hGet(keys.namespaces, "chat")).toBe(String(sessionIds.length));
    for (const [sessionId, sessionRooms] of Object.entries(rooms)) {
      expect(
        [...((await readSession(raw, keys.sessions, sessionId))?.rooms ?? [])].toSorted(),
      ).toEqual([...sessionRooms].toSorted());
    }
  }

  beforeAll(async () => {
    redis = await startRedis();
    raw = await createRawClient(redis.url);
  });

  afterEach(async () => {
    await redis.ensureUnpaused();
    await shutdownAll(nodes);
  });

  afterAll(async () => {
    await raw?.close().catch(() => {});
    await redis?.stop();
  });

  it("Redis가 응답하지 않으면 호출은 commandDeadlineMs 안에 끝나고, mutation은 rebuild 대기, 읽기는 로컬 partial이 되며 로컬 전달은 계속된다", async () => {
    const prefix = uniqueName("paused");
    const node = startNode(prefix, { commandDeadlineMs: 500 });
    const b1 = await node.connect();
    const b2 = await node.connect();
    await b1.connection.join("room-1");
    await b2.connection.join("room-1");
    expect(node.adapter.presenceStore.getStatus().rebuildPending).toBe(false);

    await redis.pause();

    const mutation = await timeSettle(b1.connection.join("room-2"));
    expect(mutation.status).toBe("fulfilled");
    expect(mutation.elapsedMs).toBeLessThan(2_000);
    await eventually(() => {
      expect(node.adapter.presenceStore.getStatus().rebuildPending).toBe(true);
    });

    // store 읽기도 deadline 안에 끝난다 (resolve든 reject든)
    const storeRead = await timeSettle(
      Promise.resolve(node.adapter.presenceStore.getRoomMemberCount("room-1", "chat")),
    );
    expect(storeRead.elapsedMs).toBeLessThan(2_000);

    const startedAt = Date.now();
    expect(await node.runtime.registry.getRoomMemberCount("room-1", "chat")).toEqual({
      count: 2,
      partial: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const publish = await timeSettle(
      node.runtime.publishToRoom("room-1", "message", { seq: 1, text: "local" }, "chat"),
    );
    expect(publish.status).toBe("fulfilled");
    expect(publish.elapsedMs).toBeLessThan(2_000);
    await eventually(() => {
      expect(framesOf(b1.socket).map((frame) => frame.data.text)).toEqual(["local"]);
      expect(framesOf(b2.socket).map((frame) => frame.data.text)).toEqual(["local"]);
    });

    await redis.unpause();

    // 세션 큐가 막히지 않고 이후 mutation이 Redis에 반영된다
    await b1.connection.join("room-3");
    const keys = nodeKeys(prefix, node.nodeId);
    await eventually(
      async () => {
        expect(
          [...((await readSession(raw, keys.sessions, b1.connection.id))?.rooms ?? [])].toSorted(),
        ).toEqual(["room-1", "room-2", "room-3"]);
        expect(node.adapter.presenceStore.getStatus().rebuildPending).toBe(false);
      },
      { timeoutMs: 10_000 },
    );
    expect(await node.runtime.registry.getRoomMemberCount("room-1", "chat")).toEqual({
      count: 2,
      partial: false,
    });
  });

  it("연결이 유지된 채 응답만 멈췄다가 돌아오면 다음 성공한 heartbeat에서 rebuild한다", async () => {
    const prefix = uniqueName("heartbeat-rebuild");
    const node = startNode(prefix, {
      heartbeatIntervalMs: 300,
      nodeTimeoutMs: 3_000,
      keyTtlMs: 6_000,
      commandDeadlineMs: 500,
    });
    const b1 = await node.connect();
    const b2 = await node.connect();
    await b1.connection.join("room-1");
    await b2.connection.join("room-2");
    await b2.connection.setUserId(5);

    await corruptNodeKeys(prefix, node.nodeId, b2.connection.id);
    await redis.pause();
    b1.connection.join("room-3");
    await eventually(() => {
      expect(node.adapter.presenceStore.getStatus().rebuildPending).toBe(true);
    });
    await redis.unpause();

    // 일시정지에서는 ready나 MASTER_CHANGE가 발생하지 않으므로 heartbeat가 rebuild를 맡는다
    await eventually(
      async () => {
        expect(node.adapter.presenceStore.getStatus().rebuildPending).toBe(false);
        await expectNodeKeysMatchMemory(prefix, node.nodeId, [b1.connection.id, b2.connection.id], {
          [b1.connection.id]: ["room-1", "room-3"],
          [b2.connection.id]: ["room-2"],
        });
      },
      { timeoutMs: 10_000, intervalMs: 100 },
    );
    expect(Object.values(await hashFields(raw, nodeKeys(prefix, node.nodeId).users))).toEqual([
      "1",
    ]);
  });

  it("쓰기 실패 뒤 연결이 끊겼다가 재연결(ready)되면 메모리 상태로 노드 키를 다시 써서 수렴하고 구독도 유지된다", async () => {
    const prefix = uniqueName("reconnect-rebuild");
    const quiet = {
      heartbeatIntervalMs: 600_000,
      nodeTimeoutMs: 1_800_000,
      keyTtlMs: 3_600_000,
      commandDeadlineMs: 500,
    };
    const nodeA = startNode(prefix, quiet);
    const nodeB = startNode(prefix, quiet);
    await nodeA.connect();
    const b1 = await nodeB.connect();
    const b2 = await nodeB.connect();
    await b1.connection.join("room-1");
    await b2.connection.join("room-1");

    await corruptNodeKeys(prefix, nodeB.nodeId, b2.connection.id);
    await redis.pause();
    b1.connection.join("room-2");
    await eventually(() => {
      expect(nodeB.adapter.presenceStore.getStatus().rebuildPending).toBe(true);
    });
    await redis.unpause();

    // 어댑터 연결을 끊어 재연결 → ready 이벤트를 일으킨다
    expect(await killOtherClients(raw)).toBeGreaterThan(0);

    await eventually(
      async () => {
        expect(nodeB.adapter.presenceStore.getStatus()).toEqual({
          ready: true,
          rebuildPending: false,
        });
        await expectNodeKeysMatchMemory(
          prefix,
          nodeB.nodeId,
          [b1.connection.id, b2.connection.id],
          {
            [b1.connection.id]: ["room-1", "room-2"],
            [b2.connection.id]: ["room-1"],
          },
        );
      },
      { timeoutMs: 15_000, intervalMs: 100 },
    );

    // 재연결 뒤에도 노드 B 채널 구독이 살아 있어 원격 전달이 된다
    await eventually(
      async () => {
        await nodeA.runtime.publishToRoom(
          "room-2",
          "message",
          { seq: 1, text: "after-reconnect" },
          "chat",
        );
        expect(framesOf(b1.socket).map((frame) => frame.data.text)).toContain("after-reconnect");
      },
      { timeoutMs: 15_000, intervalMs: 300 },
    );
  });

  it("어댑터가 만든 client는 Redis가 오프라인이면 deadline을 기다리지 않고 즉시 실패해 rebuild 대기가 된다", async () => {
    const offlineRedis = await startRedis();
    try {
      const prefix = uniqueName("offline");
      const node = startNode(
        prefix,
        { commandDeadlineMs: 5_000, readyTimeoutMs: 5_000 },
        offlineRedis.url,
      );
      const b1 = await node.connect();
      await b1.connection.join("room-1");
      expect(node.adapter.presenceStore.getStatus().rebuildPending).toBe(false);

      await offlineRedis.stop();
      // 소켓 종료가 client에 전달될 시간을 준다
      await sleep(500);

      const storeRead = await timeSettle(
        Promise.resolve(node.adapter.presenceStore.getRoomMemberCount("room-1", "chat")),
      );
      expect(storeRead.status).toBe("rejected");
      expect(storeRead.elapsedMs).toBeLessThan(1_000);

      const mutationStartedAt = Date.now();
      const mutation = await timeSettle(b1.connection.join("room-2"));
      expect(mutation.status).toBe("fulfilled");
      await eventually(
        () => {
          expect(node.adapter.presenceStore.getStatus().rebuildPending).toBe(true);
        },
        { timeoutMs: 1_000, intervalMs: 20 },
      );
      expect(Date.now() - mutationStartedAt).toBeLessThan(1_500);

      const count = await timeSettle(node.runtime.registry.getRoomMemberCount("room-2", "chat"));
      expect(count.elapsedMs).toBeLessThan(1_000);
      expect(await node.runtime.registry.getRoomMemberCount("room-2", "chat")).toEqual({
        count: 1,
        partial: true,
      });

      await node.runtime.publishToRoom(
        "room-2",
        "message",
        { seq: 1, text: "offline-local" },
        "chat",
      );
      await eventually(() => {
        expect(framesOf(b1.socket).map((frame) => frame.data.text)).toEqual(["offline-local"]);
      });
    } finally {
      await shutdownAll(nodes);
      await offlineRedis.stop().catch(() => {});
    }
  });

  it("Redis가 ready에 도달하지 못하면 registerConnection은 readyTimeoutMs 뒤 로컬 전용으로 등록되고 rebuild 대기가 된다", async () => {
    const silent = await startSilentTcpServer();
    try {
      const prefix = uniqueName("ready-timeout");
      const node = startNode(prefix, { readyTimeoutMs: 600, commandDeadlineMs: 500 }, silent.url);

      const startedAt = Date.now();
      const { socket, registering } = node.startConnect();
      const connection = await registering;
      const elapsedMs = Date.now() - startedAt;

      // 첫 사용에서 lazy connect를 readyTimeoutMs까지 기다린 뒤 포기한다
      expect(elapsedMs).toBeGreaterThanOrEqual(500);
      expect(elapsedMs).toBeLessThan(600 + 500 + 1_500);
      expect(node.runtime.registry.getConnection(connection.id)).toBeDefined();
      expect(node.adapter.presenceStore.getStatus()).toEqual({
        ready: false,
        rebuildPending: true,
      });

      const joined = await timeSettle(connection.join("room-1"));
      expect(joined.status).toBe("fulfilled");
      expect(joined.elapsedMs).toBeLessThan(600 + 500 + 1_500);
      await node.runtime.publishToRoom("room-1", "message", { seq: 1, text: "local-only" }, "chat");
      await eventually(() => {
        expect(framesOf(socket).map((frame) => frame.data.text)).toEqual(["local-only"]);
      });

      const shutdown = await timeSettle(node.shutdown());
      expect(shutdown.status).toBe("fulfilled");
      expect(shutdown.elapsedMs).toBeLessThan(5_000);
    } finally {
      await shutdownAll(nodes);
      await silent.close();
    }
  });
});
