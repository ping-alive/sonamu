import {
  createWebSocketRuntime,
  type WebSocketRuntime,
  type WebSocketRuntimeOptions,
} from "sonamu";
import { z } from "zod";

import {
  createRedisWebSocketAdapter,
  type RedisWebSocketAdapter,
  type RedisWebSocketAdapterOptions,
} from "../../src/index";
import { asWebSocket, FakeWebSocket } from "./fake-socket";
import { settleWithin } from "./redis-container";

export const ROUTES = {
  chat: "/chat",
  chatAlt: "/chat-alt",
  audit: "/audit",
} as const;

export type RouteName = keyof typeof ROUTES;

// 기본 채팅 route. z.date() 필드로 원격 직렬화 문제를 재현한다
export const ChatOutEvents = z.object({
  message: z.object({ seq: z.number(), text: z.string() }),
  stamped: z.object({ at: z.date(), label: z.string() }),
});

// 같은 namespace의 다른 route. 같은 이벤트 이름이지만 스키마가 달라 text 필드가 frame에서 빠진다
export const ChatAltOutEvents = z.object({
  message: z.object({ seq: z.number() }),
});

// message 이벤트를 선언하지 않은 route. 이 route의 연결은 message publish 대상에서 빠져야 한다
export const AuditOutEvents = z.object({
  audit: z.object({ action: z.string() }),
});

export const NoInEvents = z.object({});

type AnyOutEvents = z.ZodObject<Record<string, z.ZodType>>;

const OUT_EVENTS = {
  chat: ChatOutEvents,
  chatAlt: ChatAltOutEvents,
  audit: AuditOutEvents,
} satisfies Record<RouteName, AnyOutEvents>;

// route마다 스키마가 다르므로 registerConnection에는 넓힌 스키마 타입으로 넘긴다
function outEventsOf(route: RouteName): AnyOutEvents {
  return OUT_EVENTS[route];
}

const ROUTE_NAMES: RouteName[] = ["chat", "chatAlt", "audit"];

// 만료/heartbeat 테스트를 빠르게 하기 위한 짧은 기본값
export const FAST_ADAPTER_OPTIONS = {
  heartbeatIntervalMs: 200,
  nodeTimeoutMs: 1_000,
  keyTtlMs: 2_000,
  commandDeadlineMs: 500,
  readyTimeoutMs: 1_000,
  drainTimeoutMs: 500,
} satisfies Partial<RedisWebSocketAdapterOptions>;

export type ConnectOptions = {
  route?: RouteName;
  namespace?: string;
  active?: boolean;
};

export type TestConnection = {
  socket: FakeWebSocket;
  connection: Awaited<ReturnType<WebSocketRuntime["registerConnection"]>>;
};

export type TestNode = {
  nodeId: string;
  adapter: RedisWebSocketAdapter;
  runtime: WebSocketRuntime;
  connect(options?: ConnectOptions): Promise<TestConnection>;
  // 등록 promise를 기다리지 않고 소켓과 promise를 함께 돌려준다 (등록 전 close 테스트용)
  startConnect(options?: ConnectOptions): {
    socket: FakeWebSocket;
    registering: ReturnType<WebSocketRuntime["registerConnection"]>;
  };
  shutdown(): Promise<void>;
};

/**
 * Redis 어댑터를 spread해 만든 WebSocket runtime 하나를 노드로 띄운다.
 * 모든 노드는 같은 route 집합을 등록한다 (route key가 클러스터 전체에서 일치해야 한다).
 */
export function createTestNode(input: {
  adapterOptions: RedisWebSocketAdapterOptions;
  runtimeOptions?: Omit<WebSocketRuntimeOptions, "nodeId" | "presenceStore" | "clusterBus">;
}): TestNode {
  const adapter = createRedisWebSocketAdapter(input.adapterOptions);
  // 문서화된 사용 패턴: 어댑터 결과를 그대로 websocket 옵션에 spread한다
  const runtime = createWebSocketRuntime({
    ...adapter,
    telemetry: false,
    ...input.runtimeOptions,
  });
  for (const name of ROUTE_NAMES) {
    runtime.registerRoute(ROUTES[name], { outEvents: outEventsOf(name) });
  }

  let shutdownPromise: Promise<void> | null = null;

  const startConnect = (options: ConnectOptions = {}) => {
    const route = options.route ?? "chat";
    const socket = new FakeWebSocket();
    const registering = runtime.registerConnection(asWebSocket(socket), {
      routeKey: ROUTES[route],
      outEvents: outEventsOf(route),
      inEvents: NoInEvents,
      namespace: options.namespace ?? "chat",
      heartbeat: 0,
      active: options.active ?? true,
    });
    return { socket, registering };
  };

  return {
    nodeId: adapter.nodeId,
    adapter,
    runtime,
    startConnect,
    async connect(options = {}) {
      const { socket, registering } = startConnect(options);
      const connection = await registering;
      return { socket, connection };
    },
    shutdown() {
      shutdownPromise ??= runtime.shutdown();
      return shutdownPromise;
    },
  };
}

/**
 * afterEach 정리용. 테스트가 실패했더라도 노드 shutdown이 다음 테스트를 막지 않도록 상한을 둔다.
 */
export async function shutdownAll(nodes: TestNode[], timeoutMs: number = 15_000): Promise<void> {
  await Promise.all(nodes.map((node) => settleWithin(node.shutdown(), timeoutMs)));
  nodes.length = 0;
}

/**
 * 어댑터만 직접 쓰는 테스트의 정리용. presence store와 cluster bus를 각각 종료한다.
 */
export async function shutdownAdapters(
  adapters: RedisWebSocketAdapter[],
  timeoutMs: number = 15_000,
): Promise<void> {
  await Promise.all(
    adapters.map(async (adapter) => {
      await settleWithin(
        Promise.resolve().then(() => adapter.presenceStore.shutdown()),
        timeoutMs,
      );
      await settleWithin(
        Promise.resolve().then(() => adapter.clusterBus.shutdown()),
        timeoutMs,
      );
    }),
  );
  adapters.length = 0;
}
