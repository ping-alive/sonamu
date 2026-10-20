import { type RedisClientOptions, type RedisClientType, type RedisSentinelType } from "redis";
import { createWebSocketNodeId } from "sonamu";

/**
 * Redis 연결 입력입니다.
 * - `RedisClientOptions`: 어댑터가 클라이언트를 생성하고 소유합니다.
 * - `RedisClientType`: 호출자 소유 클라이언트이며, 어댑터는 pub/sub용 duplicate()만 소유합니다.
 * - `RedisSentinelType`: 호출자 소유 Sentinel이며, 인스턴스 subscribe를 사용합니다.
 */
export type RedisWebSocketAdapterRedisInput =
  | RedisClientOptions
  | RedisClientType
  | RedisSentinelType;

export type RedisWebSocketAdapterOptions = {
  redis: RedisWebSocketAdapterRedisInput;
  // 기본값은 sonamu createWebSocketNodeId()로 만든 `${hostname}-${pid}-${랜덤}`
  nodeId?: string;
  // 키와 pub/sub 채널 접두사. 채널에는 client keyPrefix가 붙지 않으므로 Redis를 공유하는 앱마다 다르게 설정한다
  prefix?: string;
  heartbeatIntervalMs?: number;
  nodeTimeoutMs?: number;
  keyTtlMs?: number;
  commandDeadlineMs?: number;
  readyTimeoutMs?: number;
  drainTimeoutMs?: number;
};

export type ResolvedRedisWebSocketAdapterOptions = Required<
  Omit<RedisWebSocketAdapterOptions, "redis">
>;

export const REDIS_WEBSOCKET_ADAPTER_DEFAULTS = {
  prefix: "sonamu:ws",
  heartbeatIntervalMs: 5000,
  // heartbeat 3회 누락. GC나 event loop 지연에 여유를 둔다
  nodeTimeoutMs: 15000,
  // nodeTimeoutMs의 2배. 라우팅은 nodes score로 먼저 거르므로 느리지만 살아 있는 노드의 키가 먼저 만료되지 않게 한다
  keyTtlMs: 30000,
  commandDeadlineMs: 2000,
  readyTimeoutMs: 3000,
  // 진행 중 명령의 deadline보다 길게 잡아 마지막 쓰기를 마칠 여유를 준다
  drainTimeoutMs: 5000,
} as const;

export function resolveAdapterOptions(
  options: RedisWebSocketAdapterOptions,
): ResolvedRedisWebSocketAdapterOptions {
  const resolved = {
    nodeId: options.nodeId ?? createWebSocketNodeId(),
    prefix: options.prefix ?? REDIS_WEBSOCKET_ADAPTER_DEFAULTS.prefix,
    heartbeatIntervalMs:
      options.heartbeatIntervalMs ?? REDIS_WEBSOCKET_ADAPTER_DEFAULTS.heartbeatIntervalMs,
    nodeTimeoutMs: options.nodeTimeoutMs ?? REDIS_WEBSOCKET_ADAPTER_DEFAULTS.nodeTimeoutMs,
    keyTtlMs: options.keyTtlMs ?? REDIS_WEBSOCKET_ADAPTER_DEFAULTS.keyTtlMs,
    commandDeadlineMs:
      options.commandDeadlineMs ?? REDIS_WEBSOCKET_ADAPTER_DEFAULTS.commandDeadlineMs,
    readyTimeoutMs: options.readyTimeoutMs ?? REDIS_WEBSOCKET_ADAPTER_DEFAULTS.readyTimeoutMs,
    drainTimeoutMs: options.drainTimeoutMs ?? REDIS_WEBSOCKET_ADAPTER_DEFAULTS.drainTimeoutMs,
  };

  if (resolved.nodeId === "") {
    throw new Error("Redis WebSocket adapter nodeId must not be empty.");
  }
  if (resolved.prefix === "") {
    throw new Error("Redis WebSocket adapter prefix must not be empty.");
  }
  for (const name of [
    "heartbeatIntervalMs",
    "nodeTimeoutMs",
    "keyTtlMs",
    "commandDeadlineMs",
    "readyTimeoutMs",
    "drainTimeoutMs",
  ] as const) {
    const value = resolved[name];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Redis WebSocket adapter ${name} must be a positive number.`);
    }
  }
  return resolved;
}
