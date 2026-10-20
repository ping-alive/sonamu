import { RedisWebSocketClusterBus } from "./cluster-bus";
import { RedisWebSocketConnection } from "./connection";
import { type RedisWebSocketAdapterOptions, resolveAdapterOptions } from "./options";
import { RedisWebSocketPresenceStore } from "./presence-store";

export { RedisWebSocketClusterBus } from "./cluster-bus";
export { RedisWebSocketDeadlineError } from "./deadline";
export {
  REDIS_WEBSOCKET_ADAPTER_DEFAULTS,
  type RedisWebSocketAdapterOptions,
  type RedisWebSocketAdapterRedisInput,
} from "./options";
export {
  RedisWebSocketPresenceStore,
  type RedisWebSocketPresenceStoreStatus,
} from "./presence-store";

export type RedisWebSocketAdapter = {
  nodeId: string;
  presenceStore: RedisWebSocketPresenceStore;
  clusterBus: RedisWebSocketClusterBus;
};

/**
 * Redis presence store와 cluster bus를 만든다. 결과를 WebSocket 런타임 옵션에 그대로 펼쳐 넣으면
 * runtime, store, bus가 같은 nodeId를 쓴다.
 *
 * @example
 * ```ts
 * websocket: {
 *   ...createRedisWebSocketAdapter({ redis: { url: process.env.REDIS_URL }, prefix: "my-app:ws" }),
 * }
 * ```
 *
 * 생성만으로는 Redis에 연결하지 않으며 첫 사용 때 연결한다.
 */
export function createRedisWebSocketAdapter(
  options: RedisWebSocketAdapterOptions,
): RedisWebSocketAdapter {
  const resolved = resolveAdapterOptions(options);
  const connection = new RedisWebSocketConnection(options.redis, resolved);
  return {
    nodeId: resolved.nodeId,
    presenceStore: new RedisWebSocketPresenceStore(connection),
    clusterBus: new RedisWebSocketClusterBus(connection),
  };
}
