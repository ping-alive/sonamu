import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createWebSocketRuntime, type WebSocketRuntime } from "../ws";
import { WebSocketAudience } from "../ws-audience";
import { InMemoryWebSocketPresenceStore } from "../ws-presence-store";
import {
  FakeWebSocket,
  RecordingClusterBus,
  ScriptedPresenceStore,
  asWebSocket,
  collectUnhandledRejections,
  createDeferred,
  flushAsync,
  flushUntil,
  isSettled,
  parseFrames,
} from "./ws-test-helpers";

const OutEvents = z.object({
  onReady: z.object({ ok: z.boolean() }),
  onSeq: z.object({ seq: z.number() }),
});
const InEvents = z.object({
  ping: z.object({}),
});

async function connect(
  runtime: WebSocketRuntime,
  socket: FakeWebSocket = new FakeWebSocket(),
  options: { active?: boolean; namespace?: string } = {},
) {
  const connection = await runtime.registerConnection(asWebSocket(socket), {
    routeKey: "/chat",
    outEvents: OutEvents,
    inEvents: InEvents,
    namespace: options.namespace ?? "chat",
    active: options.active,
    heartbeat: 0,
  });
  return { socket, connection };
}

function createRuntime(input: {
  presenceStore?: ScriptedPresenceStore | InMemoryWebSocketPresenceStore;
  clusterBus?: RecordingClusterBus;
  nodeId?: string;
  drainTimeoutMs?: number;
}): WebSocketRuntime {
  const runtime = createWebSocketRuntime({
    nodeId: input.nodeId ?? "node-a",
    presenceStore: input.presenceStore,
    clusterBus: input.clusterBus,
    drainTimeoutMs: input.drainTimeoutMs,
    telemetry: true,
  });
  runtime.registerRoute("/chat", { outEvents: OutEvents });
  return runtime;
}

function eventsNamed(runtime: WebSocketRuntime, name: string) {
  return runtime.telemetryController.getEventStore()?.query({ name }) ?? [];
}

async function registerRemoteSession(
  store: InMemoryWebSocketPresenceStore,
  input: { sessionId: string; nodeId: string; rooms?: string[]; namespace?: string },
): Promise<void> {
  await store.register({
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    namespace: input.namespace ?? "chat",
    active: true,
    connectedAt: new Date(),
  });
  for (const roomId of input.rooms ?? []) {
    await store.join(input.sessionId, roomId);
  }
}

describe("WebSocketRegistry 비동기 presence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("등록과 세션별 mutation 순서", () => {
    it("registerConnection은 store가 register를 받은 뒤 resolve하고, 그 시점에 메모리에도 연결이 있다", async () => {
      const store = new ScriptedPresenceStore();
      const gate = createDeferred();
      store.next("register", () => gate.promise);
      const runtime = createRuntime({ presenceStore: store });
      const socket = new FakeWebSocket();

      const registering = connect(runtime, socket);
      await flushAsync();

      expect(store.callsOf("register")).toHaveLength(1);
      expect(await isSettled(registering)).toBe(false);

      gate.resolve();
      const { connection } = await registering;

      expect(runtime.registry.getConnection(connection.id)).toMatchObject({
        sessionId: connection.id,
        nodeId: "node-a",
        namespace: "chat",
      });
      expect(store.inner.getConnection(connection.id)).toMatchObject({
        sessionId: connection.id,
        nodeId: "node-a",
        namespace: "chat",
        active: true,
      });
      expect(store.inner.getConnection(connection.id)?.connectedAt).toBeInstanceOf(Date);
    });

    it("느린 mutation이 있어도 store는 같은 세션의 호출을 호출 순서대로 받는다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const { connection } = await connect(runtime, new FakeWebSocket(), { active: false });
      const gate = createDeferred();
      store.next("join", () => gate.promise);
      const before = store.calls.length;

      const results = [
        runtime.activateConnection(connection.id),
        connection.join("room-1"),
        connection.leave("room-1"),
        connection.join("room-2"),
        connection.setUserId(7),
        connection.clearUserId(),
      ];
      await flushAsync();

      // 앞선 join이 끝나기 전에는 뒤 mutation이 store에 도달하지 않는다
      expect(store.calls.slice(before)).toEqual([
        `activate:${connection.id}`,
        `join:${connection.id}:room-1`,
      ]);
      // 메모리는 호출 시점에 이미 반영돼 있다
      expect(runtime.registry.getRoomMembers("room-2", "chat")).toHaveLength(1);
      expect(runtime.registry.getRoomMembers("room-1", "chat")).toHaveLength(0);

      gate.resolve();
      await Promise.all(results);

      expect(store.calls.slice(before)).toEqual([
        `activate:${connection.id}`,
        `join:${connection.id}:room-1`,
        `leave:${connection.id}:room-1`,
        `join:${connection.id}:room-2`,
        `setUserId:${connection.id}:7`,
        `clearUserId:${connection.id}`,
      ]);
    });

    it("한 세션의 느린 mutation이 다른 세션의 mutation을 막지 않는다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const first = await connect(runtime);
      const second = await connect(runtime);
      const gate = createDeferred();
      store.next("join", () => gate.promise);

      void first.connection.join("room-slow");
      await second.connection.join("room-fast");

      expect(store.calls).toContain(`join:${second.connection.id}:room-fast`);
      gate.resolve();
    });

    it("느린 register 도중 소켓이 닫히면 unregister는 register가 끝난 뒤에 호출되고 store에 아무것도 남지 않는다", async () => {
      const store = new ScriptedPresenceStore();
      const gate = createDeferred();
      store.next("register", () => gate.promise);
      const runtime = createRuntime({ presenceStore: store });
      const socket = new FakeWebSocket();

      const registering = connect(runtime, socket);
      await flushAsync();
      // 리스너는 동기로 붙어 있어야 등록 중 close를 관찰할 수 있다
      socket.close(1000, "bye");
      await flushAsync();

      expect(store.callsOf("unregister")).toEqual([]);

      gate.resolve();
      const { connection } = await registering;
      await flushUntil(() => store.callsOf("unregister").length > 0);

      expect(connection.closed).toBe(true);
      expect(store.calls).toEqual([`register:${connection.id}`, `unregister:${connection.id}`]);
      expect(store.inner.getConnection(connection.id)).toBeUndefined();
      expect(await store.inner.resolveRoute(WebSocketAudience.all(), "someone-else")).toEqual({
        localSessionIds: [],
        remoteNodeIds: [],
      });
      expect(runtime.registry.getConnection(connection.id)).toBeUndefined();
      expect(runtime.registry.getConnectionCount()).toBe(0);
    });

    it("등록 직후 join한 뒤 닫혀도 store에 방/세션 고스트가 남지 않는다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const gate = createDeferred();
      const { socket, connection } = await connect(runtime);
      store.next("join", () => gate.promise);

      void connection.join("room-1");
      void connection.setUserId("user-1");
      socket.close(1000, "bye");
      gate.resolve();
      await flushUntil(() => store.callsOf("unregister").length > 0);
      await flushAsync();

      expect(store.calls.at(-1)).toBe(`unregister:${connection.id}`);
      expect(await store.inner.getRoomMemberCount("room-1")).toBe(0);
      expect(
        await store.inner.resolveRoute(WebSocketAudience.user("user-1"), "someone-else"),
      ).toEqual({ localSessionIds: [], remoteNodeIds: [] });
    });

    it("store.register가 reject하면 메모리 전용 등록으로 resolve하고 로컬 전달은 계속된다", async () => {
      const store = new ScriptedPresenceStore();
      store.next("register", () => Promise.reject(new Error("redis down")));
      const runtime = createRuntime({ presenceStore: store });
      const collect = collectUnhandledRejections();

      const { socket, connection } = await connect(runtime);
      void connection.join("room-1");
      await runtime.publishToRoom("room-1", "onReady", { ok: true }, "chat");
      await flushUntil(() => socket.sentMessages.length > 0);

      expect(collect()).toEqual([]);
      expect(connection.closed).toBe(false);
      expect(runtime.registry.getConnection(connection.id)).toBeDefined();
      expect(parseFrames(socket)).toEqual([{ event: "onReady", data: { ok: true } }]);
      expect(eventsNamed(runtime, "ws.registry.mutation.failed").map((e) => e.detail)).toEqual(
        expect.arrayContaining([expect.objectContaining({ operation: "register" })]),
      );
    });

    it("store.register가 동기로 throw해도 registerConnection은 resolve한다", async () => {
      const store = new ScriptedPresenceStore();
      store.next("register", () => {
        throw new Error("sync failure");
      });
      const runtime = createRuntime({ presenceStore: store });

      const { connection } = await connect(runtime);

      expect(connection.closed).toBe(false);
      expect(runtime.registry.getConnectionCount("chat")).toBe(1);
      expect(eventsNamed(runtime, "ws.registry.mutation.failed").map((e) => e.detail)).toEqual(
        expect.arrayContaining([expect.objectContaining({ operation: "register" })]),
      );
    });
  });

  describe("fire-and-forget 실패 처리", () => {
    it("store mutation이 동기 throw하거나 reject해도 promise는 resolve하고 unhandledRejection이 없다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const { socket, connection } = await connect(runtime, new FakeWebSocket(), {
        active: false,
      });
      store.next("activate", () => {
        throw new Error("sync activate failure");
      });
      store.next("join", () => Promise.reject(new Error("async join failure")));
      store.next("setUserId", () => {
        throw new Error("sync setUserId failure");
      });
      store.next("leave", () => Promise.reject(new Error("async leave failure")));
      store.next("clearUserId", () => Promise.reject(new Error("async clearUserId failure")));
      const collect = collectUnhandledRejections();

      // await 없이 호출해도 안전해야 한다
      void runtime.activateConnection(connection.id);
      void connection.join("room-1");
      void connection.setUserId("user-1");
      await expect(connection.join("room-2")).resolves.toBeUndefined();
      await expect(connection.leave("room-2")).resolves.toBeUndefined();
      await expect(connection.clearUserId()).resolves.toBeUndefined();
      await flushAsync(10);

      expect(collect()).toEqual([]);
      // 실패 뒤의 mutation도 순서대로 store에 도달한다
      expect(store.calls.slice(1)).toEqual([
        `activate:${connection.id}`,
        `join:${connection.id}:room-1`,
        `setUserId:${connection.id}:"user-1"`,
        `join:${connection.id}:room-2`,
        `leave:${connection.id}:room-2`,
        `clearUserId:${connection.id}`,
      ]);
      // 메모리는 store 실패와 무관하게 갱신된다
      expect(runtime.registry.getConnectionCount("chat")).toBe(1);
      expect(runtime.registry.getRoomMembers("room-1", "chat")).toHaveLength(1);
      await runtime.publishToRoom("room-1", "onReady", { ok: true }, "chat");
      await flushUntil(() => socket.sentMessages.length > 0);
      expect(socket.sentMessages).toHaveLength(1);

      const failedOperations = eventsNamed(runtime, "ws.registry.mutation.failed").map(
        (record) => record.detail?.operation,
      );
      expect(failedOperations).toEqual(
        expect.arrayContaining(["activate", "join", "setUserId", "leave", "clearUserId"]),
      );
      // 성공 telemetry 이름도 유지된다
      expect(eventsNamed(runtime, "ws.connection.activated")).toHaveLength(1);
      expect(eventsNamed(runtime, "ws.room.joined")).toHaveLength(2);
    });

    it("unregister가 reject해도 unhandledRejection 없이 메모리에서 제거된다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const { connection } = await connect(runtime);
      store.next("unregister", () => Promise.reject(new Error("unregister failure")));
      const collect = collectUnhandledRejections();

      connection.close(1000, "done");
      await flushAsync(10);

      expect(collect()).toEqual([]);
      expect(runtime.registry.getConnection(connection.id)).toBeUndefined();
      expect(eventsNamed(runtime, "ws.connection.unregistered")).toHaveLength(1);
      expect(eventsNamed(runtime, "ws.registry.mutation.failed").map((e) => e.detail)).toEqual(
        expect.arrayContaining([expect.objectContaining({ operation: "unregister" })]),
      );
    });

    it("없는 연결에 대한 mutation은 skipped telemetry만 남기고 store를 호출하지 않는다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });

      await runtime.activateConnection("missing");
      await runtime.registry.join("missing", "room-1");
      await runtime.registry.leave("missing", "room-1");
      await runtime.registry.setUserId("missing", 1);
      await runtime.registry.clearUserId("missing");

      expect(store.calls).toEqual([]);
      expect(eventsNamed(runtime, "ws.registry.mutation.skipped")).toHaveLength(5);
    });

    it("touch(인바운드 메시지·pong)는 메모리만 갱신하고 store를 호출하지 않는다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const { socket, connection } = await connect(runtime);
      const handled = createDeferred();
      connection.onMessage("ping", () => {
        handled.resolve();
      });
      const before = store.calls.length;

      socket.emit("message", JSON.stringify({ event: "ping", data: {} }));
      socket.emit("pong");
      await handled.promise;
      await flushAsync();

      expect(store.calls.slice(before)).toEqual([]);
      expect(connection.closed).toBe(false);
    });
  });

  describe("publish", () => {
    it("라우팅 속도가 달라도 한 노드의 publish 순서는 로컬과 원격 모두에서 유지된다", async () => {
      const inner = new InMemoryWebSocketPresenceStore();
      const store = new ScriptedPresenceStore(inner);
      const clusterBus = new RecordingClusterBus();
      const runtime = createRuntime({ presenceStore: store, clusterBus });
      const { socket, connection } = await connect(runtime);
      await connection.join("room-1");
      await registerRemoteSession(inner, {
        sessionId: "remote-1",
        nodeId: "node-b",
        rooms: ["room-1"],
      });
      const slowRoute = createDeferred();
      store.next("resolveRoute", () => slowRoute.promise);

      const first = runtime.publishToRoom("room-1", "onSeq", { seq: 1 }, "chat");
      const second = runtime.publishToRoom("room-1", "onSeq", { seq: 2 }, "chat");
      await flushAsync(5);

      // 첫 publish의 라우팅이 끝나기 전에는 두 번째 publish가 원격으로 앞질러 나가지 않는다
      expect(clusterBus.published).toEqual([]);

      slowRoute.resolve();
      await Promise.all([first, second]);
      await flushUntil(() => socket.sentMessages.length >= 2);

      expect(
        clusterBus.published.map((envelope) => JSON.parse(envelope.frames["/chat"]).data),
      ).toEqual([{ seq: 1 }, { seq: 2 }]);
      expect(parseFrames(socket).map((frame) => frame.data)).toEqual([{ seq: 1 }, { seq: 2 }]);
    });

    it("connections audience는 store.resolveRoute를 호출하지 않고 세션 ID의 노드로 라우팅한다", async () => {
      const store = new ScriptedPresenceStore();
      const clusterBus = new RecordingClusterBus();
      const runtime = createRuntime({ presenceStore: store, clusterBus });
      const { socket, connection } = await connect(runtime);
      const remote = createWebSocketRuntime({ nodeId: "node-b" });
      remote.registerRoute("/chat", { outEvents: OutEvents });
      const { connection: remoteConnection } = await connect(remote);

      await runtime.publishToAudience(
        WebSocketAudience.connections([connection.id, remoteConnection.id]),
        "onReady",
        { ok: true },
      );
      await flushUntil(() => socket.sentMessages.length > 0);

      expect(store.callsOf("resolveRoute")).toEqual([]);
      expect(socket.sentMessages).toHaveLength(1);
      expect(clusterBus.published).toHaveLength(1);
      expect(clusterBus.published[0].targetNodeIds).toEqual(["node-b"]);
    });

    it("resolveRoute가 reject하면 로컬 전달만 하고 원격은 건너뛰며 telemetry를 남기고 resolve한다", async () => {
      const inner = new InMemoryWebSocketPresenceStore();
      const store = new ScriptedPresenceStore(inner);
      const clusterBus = new RecordingClusterBus();
      const runtime = createRuntime({ presenceStore: store, clusterBus });
      const { socket, connection } = await connect(runtime);
      await connection.join("room-1");
      await registerRemoteSession(inner, {
        sessionId: "remote-1",
        nodeId: "node-b",
        rooms: ["room-1"],
      });
      store.next("resolveRoute", () => Promise.reject(new Error("route failure")));
      store.next("resolveRoute", () => {
        throw new Error("sync route failure");
      });
      const collect = collectUnhandledRejections();

      await expect(
        runtime.publishToRoom("room-1", "onReady", { ok: true }, "chat"),
      ).resolves.toBeUndefined();
      await expect(
        runtime.publishToRoom("room-1", "onReady", { ok: false }, "chat"),
      ).resolves.toBeUndefined();
      await flushUntil(() => socket.sentMessages.length >= 2);
      await flushAsync();

      expect(collect()).toEqual([]);
      expect(parseFrames(socket).map((frame) => frame.data)).toEqual([{ ok: true }, { ok: false }]);
      expect(clusterBus.published).toEqual([]);
      expect(eventsNamed(runtime, "ws.fanout.route.failed")).toHaveLength(2);
    });

    it("clusterBus.publish가 reject해도 publish는 resolve하고 ws.cluster.envelope.failed를 남긴다", async () => {
      const store = new InMemoryWebSocketPresenceStore();
      const clusterBus = new RecordingClusterBus();
      clusterBus.publish = () => Promise.reject(new Error("bus down"));
      const runtime = createRuntime({ presenceStore: store, clusterBus });
      await registerRemoteSession(store, {
        sessionId: "remote-1",
        nodeId: "node-b",
        rooms: ["room-1"],
      });
      const collect = collectUnhandledRejections();

      await expect(
        runtime.publishToRoom("room-1", "onReady", { ok: true }, "chat"),
      ).resolves.toBeUndefined();
      await flushUntil(() => eventsNamed(runtime, "ws.cluster.envelope.failed").length > 0);

      expect(collect()).toEqual([]);
      expect(eventsNamed(runtime, "ws.cluster.envelope.failed")).toHaveLength(1);
      expect(
        runtime.telemetryController
          .getSpanStore()
          ?.query({ operationName: "ws.cluster.publish" })
          .map((span) => span.status),
      ).toEqual(["error"]);
    });

    it("subscribe가 reject해도 runtime은 로컬 전용으로 동작하고 telemetry를 남긴다", async () => {
      const clusterBus = new RecordingClusterBus();
      clusterBus.subscribe = () => Promise.reject(new Error("subscribe failure"));
      const collect = collectUnhandledRejections();
      const runtime = createRuntime({ clusterBus });
      const { socket } = await connect(runtime);

      await runtime.broadcast("onReady", { ok: true }, "chat");
      await flushUntil(() => socket.sentMessages.length > 0);
      await flushAsync();

      expect(collect()).toEqual([]);
      expect(socket.sentMessages).toHaveLength(1);
      expect(eventsNamed(runtime, "ws.cluster.subscribe.failed")).toHaveLength(1);
      await expect(runtime.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("읽기 API와 telemetry", () => {
    it("getRoomMemberCount는 store 성공 시 클러스터 전체 수와 partial: false를 반환한다", async () => {
      const inner = new InMemoryWebSocketPresenceStore();
      const store = new ScriptedPresenceStore(inner);
      const runtime = createRuntime({ presenceStore: store });
      const { connection } = await connect(runtime);
      await connection.join("room-1");
      await registerRemoteSession(inner, {
        sessionId: "remote-1",
        nodeId: "node-b",
        rooms: ["room-1"],
      });
      await registerRemoteSession(inner, {
        sessionId: "remote-2",
        nodeId: "node-b",
        rooms: ["room-1"],
        namespace: "admin",
      });

      await expect(runtime.registry.getRoomMemberCount("room-1", "chat")).resolves.toEqual({
        count: 2,
        partial: false,
      });
      await expect(runtime.registry.getRoomMemberCount("room-1")).resolves.toEqual({
        count: 3,
        partial: false,
      });
      // 노드 로컬 읽기는 원격 세션을 포함하지 않는다
      expect(runtime.registry.getRoomMembers("room-1").map((meta) => meta.sessionId)).toEqual([
        connection.id,
      ]);
      expect(runtime.registry.getConnectionCount()).toBe(1);
      expect(runtime.registry.getStats()).toMatchObject({
        totalConnections: 1,
        byNamespace: { chat: 1 },
      });
    });

    it("getRoomMemberCount는 store가 실패하면 로컬 수와 partial: true를 반환하고 reject하지 않는다", async () => {
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const first = await connect(runtime);
      const second = await connect(runtime);
      const inactive = await connect(runtime, new FakeWebSocket(), { active: false });
      await first.connection.join("room-1");
      await second.connection.join("room-1");
      await inactive.connection.join("room-1");
      store.next("getRoomMemberCount", () => Promise.reject(new Error("read failure")));
      store.next("getRoomMemberCount", () => {
        throw new Error("sync read failure");
      });
      const collect = collectUnhandledRejections();

      await expect(runtime.registry.getRoomMemberCount("room-1", "chat")).resolves.toEqual({
        count: 2,
        partial: true,
      });
      await expect(runtime.registry.getRoomMemberCount("room-1")).resolves.toEqual({
        count: 2,
        partial: true,
      });
      await flushAsync();

      expect(collect()).toEqual([]);
      expect(eventsNamed(runtime, "ws.registry.read.failed")).toHaveLength(2);
    });

    it("telemetry collect는 동기이고 공유 store의 원격 세션을 세지 않는다", async () => {
      const store = new InMemoryWebSocketPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      const { connection } = await connect(runtime);
      await connection.join("room-1");
      await registerRemoteSession(store, {
        sessionId: "remote-1",
        nodeId: "node-b",
        rooms: ["room-1", "room-2"],
      });
      await registerRemoteSession(store, {
        sessionId: "remote-2",
        nodeId: "node-c",
        rooms: ["room-3"],
        namespace: "admin",
      });

      const snapshot = runtime.telemetryController.getMetricsSnapshot();

      expect(snapshot).not.toBeInstanceOf(Promise);
      expect(snapshot).toMatchObject({
        activeConnections: 1,
        activeConnectionsByNamespace: { chat: 1 },
        roomCount: 1,
      });
    });
  });

  describe("nodeId 일관성", () => {
    it("store나 bus의 nodeId가 runtime nodeId와 다르면 생성 시 즉시 실패한다", () => {
      const mismatchedStore = new ScriptedPresenceStore();
      mismatchedStore.nodeId = "node-b";
      const mismatchedBus = new RecordingClusterBus();
      mismatchedBus.nodeId = "node-b";

      expect(() =>
        createWebSocketRuntime({ nodeId: "node-a", presenceStore: mismatchedStore }),
      ).toThrow();
      expect(() =>
        createWebSocketRuntime({ nodeId: "node-a", clusterBus: mismatchedBus }),
      ).toThrow();
    });

    it("store와 bus의 nodeId가 runtime nodeId와 같으면 정상 생성된다", async () => {
      const store = new ScriptedPresenceStore();
      store.nodeId = "node-a";
      const bus = new RecordingClusterBus();
      bus.nodeId = "node-a";

      const runtime = createWebSocketRuntime({
        nodeId: "node-a",
        presenceStore: store,
        clusterBus: bus,
      });

      expect(runtime.registry.nodeId).toBe("node-a");
      await runtime.shutdown();
    });
  });

  describe("shutdown drain", () => {
    it("shutdown은 연결을 닫고 진행 중인 mutation이 끝난 뒤 store.shutdown과 bus.shutdown을 호출한다", async () => {
      const store = new ScriptedPresenceStore();
      const clusterBus = new RecordingClusterBus();
      const runtime = createRuntime({ presenceStore: store, clusterBus, drainTimeoutMs: 10_000 });
      const { socket, connection } = await connect(runtime);
      const gate = createDeferred();
      store.next("unregister", () => gate.promise);

      const shuttingDown = runtime.shutdown();
      await flushAsync(5);

      expect(socket.closedWith?.code).toBe(1001);
      expect(store.callsOf("unregister")).toEqual([`unregister:${connection.id}`]);
      expect(store.callsOf("shutdown")).toEqual([]);
      expect(clusterBus.shutdownCalls).toBe(0);

      gate.resolve();
      await shuttingDown;

      expect(store.calls.at(-1)).toBe("shutdown");
      expect(clusterBus.shutdownCalls).toBe(1);
      expect(clusterBus.unsubscribeCalls).toBe(1);
    });

    it("shutdown은 진행 중인 publish(원격 포함)를 drain한 뒤 bus를 종료한다", async () => {
      const inner = new InMemoryWebSocketPresenceStore();
      const store = new ScriptedPresenceStore(inner);
      const clusterBus = new RecordingClusterBus();
      const runtime = createRuntime({ presenceStore: store, clusterBus, drainTimeoutMs: 10_000 });
      await registerRemoteSession(inner, {
        sessionId: "remote-1",
        nodeId: "node-b",
        rooms: ["room-1"],
      });
      const slowRoute = createDeferred();
      store.next("resolveRoute", () => slowRoute.promise);

      void runtime.publishToRoom("room-1", "onReady", { ok: true }, "chat");
      const shuttingDown = runtime.shutdown();
      await flushAsync(5);

      expect(clusterBus.shutdownCalls).toBe(0);

      slowRoute.resolve();
      await shuttingDown;

      expect(clusterBus.published).toHaveLength(1);
      expect(clusterBus.shutdownCalls).toBe(1);
    });

    it("끝나지 않는 store 호출이 있어도 drainTimeoutMs 뒤에 shutdown이 끝나고 store.shutdown을 호출한다", async () => {
      const store = new ScriptedPresenceStore();
      const clusterBus = new RecordingClusterBus();
      const runtime = createRuntime({ presenceStore: store, clusterBus, drainTimeoutMs: 30 });
      await connect(runtime);
      store.next("unregister", () => new Promise<void>(() => {}));

      const startedAt = Date.now();
      await runtime.shutdown();

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(store.calls.at(-1)).toBe("shutdown");
      expect(clusterBus.shutdownCalls).toBe(1);
    });

    it("drainTimeoutMs 기본값은 5000ms다", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = new ScriptedPresenceStore();
      const runtime = createRuntime({ presenceStore: store });
      await connect(runtime);
      store.next("unregister", () => new Promise<void>(() => {}));

      const shuttingDown = runtime.shutdown();
      await vi.advanceTimersByTimeAsync(4_900);
      expect(await isSettled(shuttingDown)).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      expect(await isSettled(shuttingDown)).toBe(true);
      expect(store.calls.at(-1)).toBe("shutdown");
    });
  });

  describe("원격 라우팅 동시성", () => {
    // 로컬 연결 하나와 원격 노드 세션 하나가 room-1에 있고, resolveRoute는 호출마다 테스트가 제어하는 promise를 기다린다
    async function createPendingRouteNode(count: number, drainTimeoutMs?: number) {
      const inner = new InMemoryWebSocketPresenceStore();
      const store = new ScriptedPresenceStore(inner);
      const clusterBus = new RecordingClusterBus();
      const runtime = createRuntime({ presenceStore: store, clusterBus, drainTimeoutMs });
      const { socket, connection } = await connect(runtime);
      await connection.join("room-1");
      await registerRemoteSession(inner, {
        sessionId: "remote-1",
        nodeId: "node-b",
        rooms: ["room-1"],
      });
      const routes = Array.from({ length: count }, () => createDeferred());
      for (const route of routes) {
        store.next("resolveRoute", () => route.promise);
      }
      return { store, clusterBus, runtime, socket, routes };
    }

    // 발행된 envelope의 /chat frame에서 data만 발행 순서대로 꺼낸다
    function remoteData(clusterBus: RecordingClusterBus) {
      return clusterBus.published.map((envelope) => JSON.parse(envelope.frames["/chat"]).data);
    }

    it("연속 publish의 resolveRoute는 앞선 라우팅을 기다리지 않고 동시에 시작한다", async () => {
      const { store, clusterBus, runtime, routes } = await createPendingRouteNode(5);

      const publishes = [1, 2, 3, 4, 5].map((seq) =>
        runtime.publishToRoom("room-1", "onSeq", { seq }, "chat"),
      );
      await flushAsync(5);

      // 어느 라우팅도 끝나기 전에 다섯 publish 모두 store 조회를 시작해야 한다 (버스트 비용이 N×T가 아닌 약 T)
      expect(store.callsOf("resolveRoute")).toHaveLength(5);
      expect(clusterBus.published).toEqual([]);

      for (const route of routes) {
        route.resolve();
      }
      await Promise.all(publishes);

      expect(remoteData(clusterBus)).toEqual([
        { seq: 1 },
        { seq: 2 },
        { seq: 3 },
        { seq: 4 },
        { seq: 5 },
      ]);
    });

    it("라우팅이 역순으로 끝나도 envelope은 publish 순서대로만 발행된다", async () => {
      const { clusterBus, runtime, routes } = await createPendingRouteNode(5);
      const publishes = [1, 2, 3, 4, 5].map((seq) =>
        runtime.publishToRoom("room-1", "onSeq", { seq }, "chat"),
      );
      await flushAsync(5);

      // 뒤 publish의 라우팅이 먼저 끝나도 앞 publish보다 먼저 발행되면 안 된다
      for (const index of [4, 3, 2, 1]) {
        routes[index].resolve();
        await flushAsync(3);
        expect(clusterBus.published).toEqual([]);
      }

      routes[0].resolve();
      await Promise.all(publishes);

      expect(remoteData(clusterBus)).toEqual([
        { seq: 1 },
        { seq: 2 },
        { seq: 3 },
        { seq: 4 },
        { seq: 5 },
      ]);
    });

    it("앞선 publish의 라우팅이 늦게 끝나도 로컬과 원격 수신자 모두 A를 B보다 먼저 받는다", async () => {
      const { clusterBus, runtime, socket, routes } = await createPendingRouteNode(2);

      const first = runtime.publishToRoom("room-1", "onSeq", { seq: 1 }, "chat");
      const second = runtime.publishToRoom("room-1", "onSeq", { seq: 2 }, "chat");
      routes[1].resolve();
      await flushAsync(5);
      expect(clusterBus.published).toEqual([]);

      routes[0].resolve();
      await Promise.all([first, second]);
      await flushUntil(() => socket.sentMessages.length >= 2);

      expect(parseFrames(socket).map((frame) => frame.data)).toEqual([{ seq: 1 }, { seq: 2 }]);
      expect(remoteData(clusterBus)).toEqual([{ seq: 1 }, { seq: 2 }]);
    });

    it("중간 publish의 라우팅이 실패해도 나머지 envelope은 순서대로 발행되고 실패 telemetry를 남긴다", async () => {
      const { clusterBus, runtime, routes } = await createPendingRouteNode(3);
      const collect = collectUnhandledRejections();
      const publishes = [1, 2, 3].map((seq) =>
        runtime.publishToRoom("room-1", "onSeq", { seq }, "chat"),
      );
      await flushAsync(5);

      routes[2].resolve();
      routes[1].reject(new Error("route failure"));
      routes[0].resolve();
      await expect(Promise.all(publishes)).resolves.toEqual([undefined, undefined, undefined]);
      await flushAsync();

      expect(collect()).toEqual([]);
      expect(remoteData(clusterBus)).toEqual([{ seq: 1 }, { seq: 3 }]);
      expect(eventsNamed(runtime, "ws.fanout.route.failed")).toHaveLength(1);
    });

    it("resolveRoute가 끝나지 않아도 로컬 전달은 지연되지 않는다", async () => {
      const { clusterBus, runtime, socket } = await createPendingRouteNode(2);

      const first = runtime.publishToRoom("room-1", "onSeq", { seq: 1 }, "chat");
      const second = runtime.publishToRoom("room-1", "onSeq", { seq: 2 }, "chat");
      await flushUntil(() => socket.sentMessages.length >= 2);

      expect(parseFrames(socket).map((frame) => frame.data)).toEqual([{ seq: 1 }, { seq: 2 }]);
      expect(clusterBus.published).toEqual([]);
      // 원격 라우팅이 끝나지 않았으므로 publish promise는 아직 settle되지 않는다
      expect(await isSettled(first)).toBe(false);
      expect(await isSettled(second)).toBe(false);
    });

    it("라우팅이 끝나지 않는 publish가 여러 개 있어도 shutdown은 drainTimeoutMs 안에 끝난다", async () => {
      const { store, clusterBus, runtime } = await createPendingRouteNode(5, 30);
      const publishes = [1, 2, 3, 4, 5].map((seq) =>
        runtime.publishToRoom("room-1", "onSeq", { seq }, "chat"),
      );
      await flushAsync(3);

      const startedAt = Date.now();
      await runtime.shutdown();

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(clusterBus.published).toEqual([]);
      expect(store.calls.at(-1)).toBe("shutdown");
      expect(clusterBus.shutdownCalls).toBe(1);
      expect(publishes).toHaveLength(5);
    });
  });
});
