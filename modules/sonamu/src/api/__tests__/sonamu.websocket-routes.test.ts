import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { RecordingClusterBus, flushAsync } from "../../stream/__tests__/ws-test-helpers";
import { createWebSocketRuntime, type WebSocketRuntime } from "../../stream/ws";
import { InMemoryWebSocketPresenceStore } from "../../stream/ws-presence-store";
import { type SonamuFastifyConfig } from "../../types/types";
import { type ExtendedApi } from "../decorators";
import { Sonamu } from "../sonamu";

const ChatEventsV1 = z.object({
  onMessage: z.object({ text: z.string() }),
});
// HMR로 바뀐 스키마: 기본값 필드가 추가돼 인코딩 결과가 달라진다
const ChatEventsV2 = z.object({
  onMessage: z.object({ text: z.string(), edited: z.boolean().default(true) }),
});
const NoticeEvents = z.object({
  onNotice: z.object({ level: z.number() }),
});
const AlertEvents = z.object({
  onAlert: z.object({ message: z.string() }),
});

function createWebSocketApi(input: {
  modelName: string;
  methodName: string;
  path: string;
  outEvents: z.ZodObject;
}): ExtendedApi {
  return {
    modelName: input.modelName,
    methodName: input.methodName,
    path: input.path,
    options: {},
    websocketOptions: {
      outEvents: input.outEvents,
      inEvents: z.object({}),
      namespace: "chat",
    },
    typeParameters: [],
    parameters: [],
    returnType: "void",
  };
}

const chatApi = (outEvents: z.ZodObject) =>
  createWebSocketApi({
    modelName: "ChatFrame",
    methodName: "subscribe",
    path: "/chat/subscribe",
    outEvents,
  });
const noticeApi = createWebSocketApi({
  modelName: "NoticeFrame",
  methodName: "subscribe",
  path: "/notice/subscribe",
  outEvents: NoticeEvents,
});
const alertApi = createWebSocketApi({
  modelName: "AlertFrame",
  methodName: "subscribe",
  path: "/alert/subscribe",
  outEvents: AlertEvents,
});

// 테스트가 서버 측에서 publish하는 payload 모양
type ServerPublishData = { text: string; extra?: number } | { level: number } | { message: string };

const config = /* SAFETY: route 등록 단계는 SonamuFastifyConfig의 함수를 호출하지 않는다. */ {
  contextProvider(defaultContext) {
    return defaultContext;
  },
  guardHandler() {},
} as SonamuFastifyConfig;

describe("Sonamu websocket route table 등록", () => {
  const originalState = Sonamu.captureTestingSnapshot();
  const originalInitialized = Sonamu.isInitialized;
  const originalNodeEnv = process.env.NODE_ENV;
  const servers: FastifyInstance[] = [];
  let tempRoot: string;
  let runtime: WebSocketRuntime;
  let clusterBus: RecordingClusterBus;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "sonamu-ws-routes-"));
    // web, web-dist가 없는 api 루트를 만들어 dev/prod 모두 정적 서빙 없이 route만 등록하게 한다
    Reflect.set(Sonamu, "apiRootPathValue", path.join(tempRoot, "api"));
    Reflect.set(Sonamu, "configValue", {
      sync: { targets: [] },
      api: { route: { prefix: "/api" } },
      server: {},
      validation: { zodCompiler: false },
    });
    Sonamu.isInitialized = true;

    // 원격 노드 node-b의 세션이 room-1에 있고, 이 노드(node-a)에는 로컬 연결이 하나도 없다
    const presenceStore = new InMemoryWebSocketPresenceStore();
    await presenceStore.register({
      sessionId: "remote-1",
      nodeId: "node-b",
      namespace: "chat",
      active: true,
      connectedAt: new Date(),
    });
    await presenceStore.join("remote-1", "room-1");
    clusterBus = new RecordingClusterBus();
    runtime = createWebSocketRuntime({ nodeId: "node-a", presenceStore, clusterBus });
    Sonamu.websocketRuntime = runtime;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    Sonamu.restoreTestingSnapshot(originalState);
    Sonamu.isInitialized = originalInitialized;
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  function setApis(apis: ExtendedApi[]): void {
    Reflect.set(Sonamu, "syncerValue", {
      apis,
      models: { ChatFrame: {}, NoticeFrame: {}, AlertFrame: {} },
      types: {},
    });
  }

  async function startServer(environment: "production" | "test"): Promise<FastifyInstance> {
    process.env.NODE_ENV = environment;
    const server = Fastify();
    servers.push(server);
    await Sonamu.withFastify(server, config, { doSilent: true, enableSync: false });
    return server;
  }

  // 서버 측 publish 결과로 이 노드의 route table을 관찰한다
  async function publishAndCollectFrames(
    event: string,
    data: ServerPublishData,
  ): Promise<Record<string, string> | undefined> {
    const before = clusterBus.published.length;
    await runtime.publishToRoom("room-1", event, data, "chat");
    await flushAsync();
    const published = clusterBus.published.slice(before);
    expect(published.length).toBeLessThanOrEqual(1);
    return published[0]?.frames;
  }

  for (const environment of ["production", "test"] as const) {
    const label =
      environment === "production" ? "프로덕션 route 등록 경로" : "dev/HMR catch-all 경로";

    it(`${label}: 시작 시 모든 @websocket route의 outEvents가 api.path 키로 등록돼, 로컬 연결이 없어도 원격 수신자용 frame을 만든다`, async () => {
      setApis([chatApi(ChatEventsV1), noticeApi]);

      const server = await startServer(environment);

      // 의도한 등록 경로를 실제로 탔는지 확인한다 (프로덕션은 route별 등록, dev는 catch-all)
      if (environment === "production") {
        expect(server.hasRoute({ method: "GET", url: "/api/chat/subscribe" })).toBe(true);
        expect(server.hasRoute({ method: "GET", url: "/api/notice/subscribe" })).toBe(true);
      } else {
        expect(server.hasRoute({ method: "GET", url: "/api/*" })).toBe(true);
      }

      const chatFrames = await publishAndCollectFrames("onMessage", { text: "hi", extra: 1 });
      expect(chatFrames).toBeDefined();
      expect(Object.keys(chatFrames ?? {})).toEqual(["/chat/subscribe"]);
      expect(JSON.parse(chatFrames?.["/chat/subscribe"] ?? "null")).toEqual({
        event: "onMessage",
        data: { text: "hi" },
      });

      const noticeFrames = await publishAndCollectFrames("onNotice", { level: 2 });
      expect(Object.keys(noticeFrames ?? {})).toEqual(["/notice/subscribe"]);
      expect(JSON.parse(noticeFrames?.["/notice/subscribe"] ?? "null")).toEqual({
        event: "onNotice",
        data: { level: 2 },
      });
    });
  }

  it("HMR refresh 뒤에는 바뀐 스키마로 인코딩하고, 제거된 route는 빠지고, 추가된 route는 포함된다", async () => {
    setApis([chatApi(ChatEventsV1), noticeApi]);
    await startServer("test");

    // syncer HMR 사이클과 같은 순서: API를 다시 읽은 뒤 refreshHttpValidators를 호출한다
    setApis([chatApi(ChatEventsV2), alertApi]);
    await Sonamu.refreshHttpValidators();

    const chatFrames = await publishAndCollectFrames("onMessage", { text: "hi" });
    expect(JSON.parse(chatFrames?.["/chat/subscribe"] ?? "null")).toEqual({
      event: "onMessage",
      data: { text: "hi", edited: true },
    });

    const noticeFrames = await publishAndCollectFrames("onNotice", { level: 2 });
    expect(noticeFrames?.["/notice/subscribe"]).toBeUndefined();

    const alertFrames = await publishAndCollectFrames("onAlert", { message: "fire" });
    expect(Object.keys(alertFrames ?? {})).toEqual(["/alert/subscribe"]);
    expect(JSON.parse(alertFrames?.["/alert/subscribe"] ?? "null")).toEqual({
      event: "onAlert",
      data: { message: "fire" },
    });
  });

  it("HMR refresh로 스키마가 바뀌면 이전 스키마로만 유효한 payload는 더 이상 인코딩되지 않는다", async () => {
    const StrictV2 = z.object({ onMessage: z.object({ text: z.string().max(3) }) });
    setApis([chatApi(ChatEventsV1)]);
    await startServer("test");

    const before = await publishAndCollectFrames("onMessage", { text: "long text" });
    expect(before?.["/chat/subscribe"]).toBeDefined();

    setApis([chatApi(StrictV2)]);
    await Sonamu.refreshHttpValidators();

    const after = await publishAndCollectFrames("onMessage", { text: "long text" });
    expect(after?.["/chat/subscribe"]).toBeUndefined();
  });
});
