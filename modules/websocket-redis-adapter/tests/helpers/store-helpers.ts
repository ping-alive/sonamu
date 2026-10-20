import { type RedisWebSocketAdapter, type RedisWebSocketPresenceStore } from "../../src/index";
import { type RawRedisClient } from "./redis-container";

export const FIXED_CONNECTED_AT = new Date("2026-01-02T03:04:05.678Z");

/**
 * 0.12 PresenceStore 계약의 register 입력 형태로 세션을 등록한다.
 */
export async function registerSession(
  store: RedisWebSocketPresenceStore,
  input: {
    sessionId: string;
    nodeId: string;
    namespace?: string;
    active?: boolean;
    connectedAt?: Date;
  },
): Promise<void> {
  await store.register({
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    namespace: input.namespace ?? "chat",
    active: input.active ?? true,
    connectedAt: input.connectedAt ?? FIXED_CONNECTED_AT,
  });
}

export function adapterStore(adapter: RedisWebSocketAdapter): RedisWebSocketPresenceStore {
  return adapter.presenceStore;
}

// 세션 JSON 데이터 모델에서 테스트가 확인하는 필드
export type StoredSession = {
  namespace: string;
  active: boolean;
  rooms: string[];
  connectedAt: number;
  userId?: string | number | boolean | null | object;
};

export async function readSession(
  raw: RawRedisClient,
  sessionsKey: string,
  sessionId: string,
): Promise<StoredSession | null> {
  const value = await raw.hGet(sessionsKey, sessionId);
  if (value === null || value === undefined) {
    return null;
  }
  return /* SAFETY: 어댑터가 저장한 세션 JSON이며, 테스트 assertion이 형태를 검증한다. */ JSON.parse(
    value,
  ) as StoredSession;
}

export async function hashFields(
  raw: RawRedisClient,
  key: string,
): Promise<Record<string, string>> {
  const value = await raw.hGetAll(key);
  return { ...value };
}

export type Gate = {
  // 붙잡힌 작업이 gate에 도착했을 때 resolve된다
  reached: Promise<void>;
  markReached(): void;
  // 붙잡힌 작업을 이어서 실행시킨다
  release(): void;
  released: Promise<void>;
};

/**
 * 명령 하나를 원하는 시점까지 붙잡아 두기 위한 gate.
 * 경합 순서를 timing에 맡기지 않고 테스트가 직접 정한다.
 */
export function createGate(): Gate {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    markReached: () => reached.resolve(),
    release: () => released.resolve(),
    released: released.promise,
  };
}
