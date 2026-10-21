import { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { type WebSocket } from "ws";
import { z } from "zod";

import { type WebSocketConnection, WebSocketRuntime } from "../../stream/ws";
import { type WebSocketTelemetryConnectionContext } from "../../stream/ws-telemetry";
import { type SonamuFastifyConfig } from "../../types/types";
import { type WebSocketContext } from "../context";
import { type ExtendedApi } from "../decorators";
import { Sonamu } from "../sonamu";

// runtime.registerConnection이 돌려주는 연결 타입. spy 대역도 이 타입으로 만들어야 한다
type RuntimeWebSocketConnection = Awaited<ReturnType<WebSocketRuntime["registerConnection"]>>;

interface TestWebSocketMessage {
  roomId?: string;
}

interface TestWebSocketEvents {
  joinRoom: TestWebSocketMessage;
}

describe("Sonamu websocket context scoping", () => {
  it("웹소켓 컨텍스트를 생성한 뒤 해당 컨텍스트 안에서 guard를 실행한다", async () => {
    const executionOrder: string[] = [];
    const rawWs: RuntimeWebSocketConnection = {
      id: "ws-guard",
      namespace: "chat",
      transport: "ws" as const,
      closed: false,
      publishUntyped() {},
      close() {},
      onClose() {},
      onMessage() {},
      publish() {},
      waitForClose() {
        return Promise.resolve();
      },
      join() {
        return Promise.resolve();
      },
      leave() {
        return Promise.resolve();
      },
      setUserId() {
        return Promise.resolve();
      },
      clearUserId() {
        return Promise.resolve();
      },
    };
    const runtime = new WebSocketRuntime({ nodeId: "websocket-guard-test" });
    const originalState = Sonamu.captureTestingSnapshot();
    let contextCreated: WebSocketContext | null = null;
    let guardContext: WebSocketContext | null = null;
    let guardTransport: WebSocketContext["transport"] | null = null;

    vi.spyOn(runtime, "registerConnection").mockResolvedValue(rawWs);
    vi.spyOn(runtime, "activateConnection").mockImplementation(async () => {
      executionOrder.push("activate");
    });
    vi.spyOn(Sonamu, "createWebSocketContext").mockImplementation(async (_config, request, ws) => {
      executionOrder.push("context");
      const context: WebSocketContext = {
        transport: "ws",
        request,
        headers: request.headers,
        ws,
        naiteStore: new Map(),
        locale: "ko",
        user: null,
        session: null,
      };
      contextCreated = context;
      return context;
    });
    vi.spyOn(Sonamu, "invokeModelMethod").mockImplementation(async () => {
      executionOrder.push("handler");
    });

    const config = /* SAFETY: API 데코레이터와 Zod 검증기 등록 계약이 이 값의 타입을 보장한다. */ {
      guardHandler() {
        executionOrder.push("guard");
        guardContext = Sonamu.getContext<WebSocketContext>();
        guardTransport = guardContext.transport;
      },
      contextProvider(defaultContext) {
        return defaultContext;
      },
    } as SonamuFastifyConfig;
    const api: ExtendedApi = {
      modelName: "ChatFrame",
      methodName: "subscribe",
      path: "/chat/subscribe",
      options: { guards: ["user"] },
      websocketOptions: {
        outEvents: z.object({}),
        inEvents: z.object({}),
      },
      typeParameters: [],
      parameters: [],
      returnType: "void",
    };
    const request = /* SAFETY: API 데코레이터와 Zod 검증기 등록 계약이 이 값의 타입을 보장한다. */ {
      headers: {},
      query: {},
    } as FastifyRequest;
    try {
      Sonamu.websocketRuntime = runtime;
      Reflect.set(Sonamu, "syncerValue", { types: {} });

      await Sonamu.createWebSocketHandlerForTesting(api, config)(
        /* SAFETY: API 데코레이터와 Zod 검증기 등록 계약이 이 값의 타입을 보장한다. */ {} as WebSocket,
        request,
      );

      expect(executionOrder).toEqual(["context", "guard", "activate", "handler"]);
      expect(guardContext).toBe(contextCreated);
      expect(guardTransport).toBe("ws");
    } finally {
      Sonamu.restoreTestingSnapshot(originalState);
      vi.restoreAllMocks();
    }
  });

  it("restores websocket context inside deferred message handlers", async () => {
    const messageHandlers = new Map<
      string,
      (
        data: TestWebSocketMessage,
        telemetryContext?: WebSocketTelemetryConnectionContext,
      ) => void | Promise<void>
    >();

    const rawWs: WebSocketConnection<TestWebSocketEvents, TestWebSocketEvents> = {
      id: "ws-1",
      namespace: "chat",
      transport: "ws" as const,
      closed: false,
      publishUntyped() {},
      close() {},
      onClose() {},
      onMessage(event, handler) {
        messageHandlers.set(String(event), handler);
      },
      publish() {},
      waitForClose() {
        return Promise.resolve();
      },
      join() {
        return Promise.resolve();
      },
      leave() {
        return Promise.resolve();
      },
      setUserId() {
        return Promise.resolve();
      },
      clearUserId() {
        return Promise.resolve();
      },
    };

    let context: WebSocketContext<TestWebSocketEvents, TestWebSocketEvents> | null = null;
    const scopedWs = Sonamu.createScopedWebSocketConnectionForTesting(rawWs, () => context);

    context = {
      transport: "ws",
      request:
        /* SAFETY: 테스트는 request 속성을 읽지 않고 websocket 컨텍스트 복원만 검증합니다. */ {} as WebSocketContext["request"],
      headers: {},
      ws: scopedWs,
      naiteStore: new Map(),
      locale: "ko",
      user: null,
      session: null,
    };

    let seenTransport: WebSocketContext["transport"] | null = null;
    scopedWs.onMessage("joinRoom", async () => {
      seenTransport = Sonamu.getContext<WebSocketContext>().transport;
    });

    await messageHandlers.get("joinRoom")?.({
      roomId: "room-1",
    });

    expect(seenTransport).toBe("ws");
  });

  it("passes message trace context to scoped websocket message handlers", async () => {
    const messageHandlers = new Map<
      string,
      (
        data: TestWebSocketMessage,
        telemetryContext?: WebSocketTelemetryConnectionContext,
      ) => void | Promise<void>
    >();

    const rawWs: WebSocketConnection<TestWebSocketEvents, TestWebSocketEvents> = {
      id: "ws-1",
      namespace: "chat",
      transport: "ws" as const,
      closed: false,
      publishUntyped() {},
      close() {},
      onClose() {},
      onMessage(event, handler) {
        messageHandlers.set(String(event), handler);
      },
      publish() {},
      waitForClose() {
        return Promise.resolve();
      },
      join() {
        return Promise.resolve();
      },
      leave() {
        return Promise.resolve();
      },
      setUserId() {
        return Promise.resolve();
      },
      clearUserId() {
        return Promise.resolve();
      },
    };

    let context: WebSocketContext<TestWebSocketEvents, TestWebSocketEvents> | null = null;
    const scopedWs = Sonamu.createScopedWebSocketConnectionForTesting(rawWs, () => context);

    context = {
      transport: "ws",
      request:
        /* SAFETY: 테스트는 request 속성을 읽지 않고 websocket 컨텍스트 복원만 검증합니다. */ {} as WebSocketContext["request"],
      headers: {},
      ws: scopedWs,
      naiteStore: new Map(),
      locale: "ko",
      user: null,
      session: null,
    };

    const messageTraceContext: WebSocketTelemetryConnectionContext = {
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "parent-1",
      sampled: true,
    };
    let seenTraceContext: WebSocketTelemetryConnectionContext | undefined;

    scopedWs.onMessage("joinRoom", async (_data, telemetryContext) => {
      seenTraceContext = telemetryContext;
    });

    await messageHandlers.get("joinRoom")?.(
      {
        roomId: "room-1",
      },
      messageTraceContext,
    );

    expect(seenTraceContext).toEqual(messageTraceContext);
  });

  it("핸들러는 registerConnection과 activateConnection이 끝날 때까지 기다리며 context → guard → activate → handler 순서를 지킨다", async () => {
    const executionOrder: string[] = [];
    const rawWs: RuntimeWebSocketConnection = {
      id: "ws-async",
      namespace: "chat",
      transport: "ws" as const,
      closed: false,
      publishUntyped() {},
      close() {},
      onClose() {},
      onMessage() {},
      publish() {},
      waitForClose() {
        return Promise.resolve();
      },
      join() {
        return Promise.resolve();
      },
      leave() {
        return Promise.resolve();
      },
      setUserId() {
        return Promise.resolve();
      },
      clearUserId() {
        return Promise.resolve();
      },
    };
    const runtime = new WebSocketRuntime({ nodeId: "websocket-async-test" });
    const originalState = Sonamu.captureTestingSnapshot();
    let releaseRegister!: () => void;
    let releaseActivate!: () => void;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    const activateGate = new Promise<void>((resolve) => {
      releaseActivate = resolve;
    });

    const registerSpy = vi.spyOn(runtime, "registerConnection").mockImplementation(async () => {
      executionOrder.push("register:start");
      await registerGate;
      executionOrder.push("register:end");
      return rawWs;
    });
    const activateSpy = vi
      .spyOn(runtime, "activateConnection")
      .mockImplementation(async (connectionId) => {
        executionOrder.push(`activate:start:${connectionId}`);
        await activateGate;
        executionOrder.push("activate:end");
      });
    vi.spyOn(Sonamu, "createWebSocketContext").mockImplementation(async (_config, request, ws) => {
      executionOrder.push("context");
      return {
        transport: "ws",
        request,
        headers: request.headers,
        ws,
        naiteStore: new Map(),
        locale: "ko",
        user: null,
        session: null,
      };
    });
    vi.spyOn(Sonamu, "invokeModelMethod").mockImplementation(async () => {
      executionOrder.push("handler");
    });

    const config = /* SAFETY: 테스트는 guardHandler와 contextProvider만 사용한다. */ {
      guardHandler() {
        executionOrder.push("guard");
      },
      contextProvider(defaultContext) {
        return defaultContext;
      },
    } as SonamuFastifyConfig;
    const api: ExtendedApi = {
      modelName: "ChatFrame",
      methodName: "subscribe",
      path: "/chat/subscribe",
      options: { guards: ["user"] },
      websocketOptions: {
        outEvents: z.object({}),
        inEvents: z.object({}),
        namespace: "chat",
      },
      typeParameters: [],
      parameters: [],
      returnType: "void",
    };
    const request = /* SAFETY: 테스트는 headers와 query만 읽는다. */ {
      headers: {},
      query: {},
    } as FastifyRequest;
    const socket =
      /* SAFETY: registerConnection이 mock이라 소켓 메서드는 호출되지 않는다. */ {} as WebSocket;
    try {
      Sonamu.websocketRuntime = runtime;
      Reflect.set(Sonamu, "syncerValue", { types: {} });

      let handlerDone = false;
      const handling = Sonamu.createWebSocketHandlerForTesting(api, config)(socket, request).then(
        () => {
          handlerDone = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      // 등록이 끝나기 전에는 context를 만들지 않는다
      expect(executionOrder).toEqual(["register:start"]);

      releaseRegister();
      await new Promise<void>((resolve) => setImmediate(resolve));

      // 활성화가 끝나기 전에는 handler를 실행하지 않는다
      expect(executionOrder).toEqual([
        "register:start",
        "register:end",
        "context",
        "guard",
        "activate:start:ws-async",
      ]);
      expect(handlerDone).toBe(false);

      releaseActivate();
      await handling;

      expect(executionOrder).toEqual([
        "register:start",
        "register:end",
        "context",
        "guard",
        "activate:start:ws-async",
        "activate:end",
        "handler",
      ]);
      expect(registerSpy).toHaveBeenCalledWith(
        socket,
        expect.objectContaining({
          routeKey: "/chat/subscribe",
          namespace: "chat",
          active: false,
        }),
      );
      expect(activateSpy).toHaveBeenCalledTimes(1);
    } finally {
      Sonamu.restoreTestingSnapshot(originalState);
      vi.restoreAllMocks();
    }
  });

  it("scoped 연결의 join/leave/setUserId/clearUserId는 원본 연결의 promise를 그대로 반환한다", async () => {
    const joinPromise = Promise.resolve();
    const leavePromise = Promise.resolve();
    const setUserIdPromise = Promise.resolve();
    const clearUserIdPromise = Promise.resolve();
    const calls: string[] = [];
    const rawWs: WebSocketConnection<TestWebSocketEvents, TestWebSocketEvents> = {
      id: "ws-scoped",
      namespace: "chat",
      transport: "ws" as const,
      closed: false,
      publishUntyped() {},
      close() {},
      onClose() {},
      onMessage() {},
      publish() {},
      waitForClose() {
        return Promise.resolve();
      },
      join(roomId) {
        calls.push(`join:${roomId}`);
        return joinPromise;
      },
      leave(roomId) {
        calls.push(`leave:${roomId}`);
        return leavePromise;
      },
      setUserId(userId) {
        calls.push(`setUserId:${JSON.stringify(userId)}`);
        return setUserIdPromise;
      },
      clearUserId() {
        calls.push("clearUserId");
        return clearUserIdPromise;
      },
    };
    const scopedWs = Sonamu.createScopedWebSocketConnectionForTesting(rawWs, () => null);

    expect(scopedWs.join("room-1")).toBe(joinPromise);
    expect(scopedWs.leave("room-1")).toBe(leavePromise);
    expect(scopedWs.setUserId(1)).toBe(setUserIdPromise);
    expect(scopedWs.clearUserId()).toBe(clearUserIdPromise);
    expect(calls).toEqual(["join:room-1", "leave:room-1", "setUserId:1", "clearUserId"]);
  });
});
