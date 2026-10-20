import {
  createClient,
  type RedisClientOptions,
  type RedisClientType,
  type RedisSentinelType,
} from "redis";
import { z } from "zod";

import { type DeadlineToken, RedisWebSocketDeadlineError, withDeadline } from "./deadline";
import {
  type RedisWebSocketAdapterRedisInput,
  type ResolvedRedisWebSocketAdapterOptions,
} from "./options";
import { type LuaScript } from "./scripts";

// node-redis는 buffer 모드 구독이면 Buffer를 넘기므로 둘 다 받는다
export type RedisPubSubListener = (message: string | Buffer) => void;

/**
 * 어댑터가 쓰는 명령만 모은 인터페이스. standalone client와 Sentinel을 같은 방식으로 다룬다.
 * 키를 담는 명령은 모두 node-redis 명령 메서드로 보내 client keyPrefix가 한 번만 붙게 한다(sendCommand 금지).
 */
type RedisCommandTarget = {
  readonly isReady: boolean;
  // 어댑터 스크립트는 모두 정수를 반환한다
  evalSha(sha: string, keys: string[], args: string[]): Promise<number>;
  scriptLoad(source: string): Promise<string>;
  zAdd(key: string, score: number, member: string): Promise<void>;
  zRemRangeByScore(key: string, min: string, max: number): Promise<void>;
  zRangeByScore(key: string, min: number, max: string): Promise<string[]>;
  zRem(key: string, member: string): Promise<void>;
  // 키가 있어 만료 시간을 설정했으면 true
  pExpire(key: string, ms: number): Promise<boolean>;
  del(keys: string[]): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
};

export type RedisSubscriberTarget = {
  subscribe(channel: string, listener: RedisPubSubListener): Promise<void>;
  unsubscribe(channel: string, listener: RedisPubSubListener): Promise<void>;
};

type ConnectionOwner = "store" | "bus";

// Sentinel 인스턴스만 master/replica 조회 메서드를 가진다
function isSentinelInput(input: RedisWebSocketAdapterRedisInput): input is RedisSentinelType {
  return "getMasterNode" in input;
}

// 연결 옵션 객체에는 connect 메서드가 없다
function isClientInput(
  input: RedisWebSocketAdapterRedisInput,
): input is RedisClientType | RedisSentinelType {
  return "connect" in input;
}

// 어댑터 스크립트는 정수를 반환한다. 숫자가 아니면 0으로 본다
function toCount(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function toVoid(): void {}

function clientCommands(client: RedisClientType): RedisCommandTarget {
  return {
    get isReady() {
      return client.isReady;
    },
    evalSha: async (sha, keys, args) =>
      toCount(Number(await client.evalSha(sha, { keys, arguments: args }))),
    scriptLoad: (source) => client.scriptLoad(source),
    zAdd: (key, score, member) => client.zAdd(key, { score, value: member }).then(toVoid),
    zRemRangeByScore: (key, min, max) => client.zRemRangeByScore(key, min, max).then(toVoid),
    zRangeByScore: (key, min, max) => client.zRangeByScore(key, min, max),
    zRem: (key, member) => client.zRem(key, member).then(toVoid),
    pExpire: (key, ms) => client.pExpire(key, ms).then((reply) => reply === 1),
    del: (keys) => client.del(keys).then(toVoid),
    publish: (channel, message) => client.publish(channel, message).then(toVoid),
  };
}

function sentinelCommands(sentinel: RedisSentinelType): RedisCommandTarget {
  return {
    get isReady() {
      return sentinel.isReady;
    },
    evalSha: async (sha, keys, args) =>
      toCount(Number(await sentinel.evalSha(sha, { keys, arguments: args }))),
    scriptLoad: (source) => sentinel.scriptLoad(source),
    zAdd: (key, score, member) => sentinel.zAdd(key, { score, value: member }).then(toVoid),
    zRemRangeByScore: (key, min, max) => sentinel.zRemRangeByScore(key, min, max).then(toVoid),
    zRangeByScore: (key, min, max) => sentinel.zRangeByScore(key, min, max),
    zRem: (key, member) => sentinel.zRem(key, member).then(toVoid),
    pExpire: (key, ms) => sentinel.pExpire(key, ms).then((reply) => reply === 1),
    del: (keys) => sentinel.del(keys).then(toVoid),
    publish: (channel, message) => sentinel.publish(channel, message).then(toVoid),
  };
}

function isNoScriptError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith("NOSCRIPT");
}

// node-redis Sentinel의 topology-change 이벤트 중 어댑터가 쓰는 MASTER_CHANGE 형식
const MasterChangeEventSchema = z.object({
  type: z.literal("MASTER_CHANGE"),
  node: z.object({ host: z.string(), port: z.number() }),
});

type TopologyChangeEvent = { type: string; node?: { host: string; port: number } };

// MASTER_CHANGE면 새 master 주소를 `host:port`로 돌려준다
function masterChangeNodeOf(event: TopologyChangeEvent): string | undefined {
  const parsed = MasterChangeEventSchema.safeParse(event);
  return parsed.success ? `${parsed.data.node.host}:${parsed.data.node.port}` : undefined;
}

function ignoreError(): void {}

/**
 * 어댑터의 Redis 연결 상태와 소유권을 관리한다. presence store와 cluster bus가 하나를 공유한다.
 * - 연결 옵션 입력: 명령용 client와 pub/sub용 duplicate()를 어댑터가 만들고 닫는다.
 * - 호출자 client 입력: 호출자 client로 명령을 보내고, pub/sub용 duplicate() 하나만 어댑터가 소유한다.
 * - 호출자 Sentinel 입력: 인스턴스 명령과 subscribe를 그대로 쓰며 duplicate()를 만들지 않는다.
 * 호출자 소유 연결은 연결하거나 닫지 않는다.
 *
 * @internal createRedisWebSocketAdapter가 생성한다.
 */
export class RedisWebSocketConnection {
  readonly kind: "owned" | "client" | "sentinel";
  readonly options: ResolvedRedisWebSocketAdapterOptions;
  private readonly commands: RedisCommandTarget;
  private readonly ownedClient: RedisClientType | undefined;
  private readonly callerClient: RedisClientType | undefined;
  private readonly sentinel: RedisSentinelType | undefined;
  private subscriberClient: RedisClientType | undefined;

  private started = false;
  private everReady = false;
  private readyWaitExpired = false;
  private readyWait: Promise<void> | undefined;
  private resolveReadyWait: (() => void) | undefined;
  private readonly scriptLoads = new Map<string, Promise<string>>();
  private readonly readyCallbacks = new Set<() => void>();
  private readonly masterChangeCallbacks = new Set<() => void>();
  /**
   * 마지막으로 관찰한 master 주소(`host:port`).
   * node-redis Sentinel은 nodeAddressMap을 쓰면 master가 그대로여도 scan마다 MASTER_CHANGE를 다시 보내므로,
   * 직전 master와 다를 때만 진짜 master 변경으로 본다. A→B→A처럼 되돌아가는 변경도 매번 변경이다.
   */
  private lastMaster: string | undefined;
  private readonly released = new Set<ConnectionOwner>();
  private closePromise: Promise<void> | undefined;

  private readonly onReady = () => {
    this.markReady();
    for (const callback of this.readyCallbacks) {
      callback();
    }
  };

  private readonly onTopologyChange = (event: TopologyChangeEvent) => {
    const master = masterChangeNodeOf(event);
    if (master === undefined || master === this.lastMaster) {
      return;
    }
    this.lastMaster = master;
    for (const callback of this.masterChangeCallbacks) {
      callback();
    }
  };

  constructor(
    input: RedisWebSocketAdapterRedisInput,
    options: ResolvedRedisWebSocketAdapterOptions,
  ) {
    this.options = options;
    if (isSentinelInput(input)) {
      this.kind = "sentinel";
      this.sentinel = input;
      this.commands = sentinelCommands(input);
    } else if (isClientInput(input)) {
      this.kind = "client";
      this.callerClient = input;
      this.commands = clientCommands(input);
    } else {
      this.kind = "owned";
      this.ownedClient = this.createOwnedClient(input);
      this.commands = clientCommands(this.ownedClient);
    }
  }

  get isReady(): boolean {
    return this.commands.isReady;
  }

  get commandDeadlineMs(): number {
    return this.options.commandDeadlineMs;
  }

  /** 명령용 연결이 (재)연결되어 ready가 될 때마다 호출된다. */
  onConnectionReady(callback: () => void): void {
    this.readyCallbacks.add(callback);
  }

  /** Sentinel이 master 변경(MASTER_CHANGE)을 알릴 때마다 호출된다. */
  onMasterChange(callback: () => void): void {
    this.masterChangeCallbacks.add(callback);
  }

  /**
   * 첫 사용 때 연결을 시작한다(lazy connect). 어댑터 소유 client만 connect하고, 호출자 연결에는 이벤트 리스너만 붙인다.
   */
  start(): void {
    if (this.started || this.closePromise) {
      return;
    }
    this.started = true;
    if (this.ownedClient) {
      this.ownedClient.on("ready", this.onReady);
      // 연결 실패는 error 이벤트와 재연결 전략이 처리한다. ready 대기는 whenUsable이 상한을 둔다
      this.ownedClient.connect().catch(ignoreError);
    } else if (this.callerClient) {
      this.callerClient.on("ready", this.onReady);
    } else if (this.sentinel) {
      this.sentinel.on("ready", this.onReady);
      this.sentinel.on("topology-change", this.onTopologyChange);
    }
    if (this.commands.isReady) {
      this.markReady();
    }
  }

  /**
   * 명령을 보내도 되는 시점까지 기다린다. 한 번도 ready가 된 적 없으면 readyTimeoutMs까지만 기다리고,
   * 그 뒤나 이미 한 번 ready였던 연결은 기다리지 않는다(오프라인이면 명령이 바로 실패한다).
   * 기다릴 필요가 없으면 undefined를 돌려줘 호출자가 같은 tick에 명령을 보내 순서를 지키게 한다.
   */
  whenUsable(): Promise<void> | undefined {
    this.start();
    if (this.commands.isReady) {
      this.markReady();
    }
    if (this.everReady || this.readyWaitExpired) {
      return undefined;
    }
    this.readyWait ??= new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaitExpired = true;
        this.resolveReadyWait = undefined;
        resolve();
      }, this.options.readyTimeoutMs);
      // ready 대기만으로 프로세스 종료를 막지 않는다. 연결 중인 소켓이 있으면 그쪽이 event loop를 유지한다
      timer.unref();
      this.resolveReadyWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return this.readyWait;
  }

  /** commandDeadlineMs deadline 안에서 명령 묶음을 실행한다. */
  run<T>(
    operation: (commands: RedisCommandTarget, token: DeadlineToken) => Promise<T>,
  ): Promise<T> {
    return withDeadline((token) => operation(this.commands, token), this.options.commandDeadlineMs);
  }

  /**
   * EVALSHA로 스크립트를 실행한다. NOSCRIPT(스크립트 캐시 flush, failover 뒤의 새 master)면 SCRIPT LOAD 후 한 번만 재시도한다.
   * EVAL로 대체하지 않으며, deadline이 지났으면 재시도하지 않는다.
   *
   * 인자는 보내기 직전에 `prepareArgs`로 만든다. 재시도 때도 다시 만들므로 SCRIPT LOAD를 기다리는 동안 바뀐 메모리 상태가
   * 반영되고, 오래된 snapshot을 다시 보내지 않는다. `prepareArgs`가 undefined를 돌려주면(예: shutdown 시작) 보내지 않고 0을 돌려준다.
   */
  async evalScript(
    commands: RedisCommandTarget,
    token: DeadlineToken,
    script: LuaScript,
    keys: string[],
    prepareArgs: () => string[] | undefined,
  ): Promise<number> {
    const firstArgs = prepareArgs();
    if (firstArgs === undefined) {
      return 0;
    }
    try {
      return await commands.evalSha(script.sha, keys, firstArgs);
    } catch (cause) {
      if (!isNoScriptError(cause) || token.expired) {
        throw cause;
      }
    }
    await this.loadScript(commands, script);
    if (token.expired) {
      throw new RedisWebSocketDeadlineError(this.options.commandDeadlineMs);
    }
    // SCRIPT LOAD가 끝난 tick에서 snapshot을 만들고 바로 보낸다
    const retryArgs = prepareArgs();
    if (retryArgs === undefined) {
      return 0;
    }
    return commands.evalSha(script.sha, keys, retryArgs);
  }

  /**
   * pub/sub 연결. standalone은 어댑터 소유 duplicate()를, Sentinel은 인스턴스 subscribe를 쓴다.
   * duplicate()는 첫 구독 때 만들고 연결한다.
   */
  subscriber(onSubscriberReady: () => void): RedisSubscriberTarget {
    if (this.sentinel) {
      const sentinel = this.sentinel;
      return {
        subscribe: (channel, listener) => sentinel.subscribe(channel, listener).then(toVoid),
        unsubscribe: (channel, listener) => sentinel.unsubscribe(channel, listener).then(toVoid),
      };
    }

    if (!this.subscriberClient) {
      const base = this.ownedClient ?? this.callerClient;
      if (!base) {
        throw new Error("Redis WebSocket adapter has no client to duplicate.");
      }
      const subscriberClient = base.duplicate({
        disableOfflineQueue: true,
        commandOptions: { timeout: this.options.commandDeadlineMs },
      });
      subscriberClient.on("error", ignoreError);
      subscriberClient.on("ready", onSubscriberReady);
      subscriberClient.connect().catch(ignoreError);
      this.subscriberClient = subscriberClient;
    }
    const client = this.subscriberClient;
    return {
      subscribe: (channel, listener) => client.subscribe(channel, listener).then(toVoid),
      unsubscribe: (channel, listener) => client.unsubscribe(channel, listener).then(toVoid),
    };
  }

  get subscriberReady(): boolean {
    if (this.sentinel) {
      return this.sentinel.isReady;
    }
    return this.subscriberClient?.isReady ?? false;
  }

  /** 어댑터 소유 pub/sub 연결을 닫는다. 호출자 Sentinel의 구독 해제는 bus가 직접 한다. */
  async closeSubscriber(): Promise<void> {
    const client = this.subscriberClient;
    this.subscriberClient = undefined;
    if (client) {
      await this.closeOwnedClient(client);
    }
  }

  /**
   * store와 bus가 모두 종료되면 어댑터 소유 연결을 닫고 호출자 연결에 붙인 리스너를 뗀다.
   */
  release(owner: ConnectionOwner): Promise<void> {
    this.released.add(owner);
    if (this.released.size < 2) {
      return Promise.resolve();
    }
    this.closePromise ??= this.close();
    return this.closePromise;
  }

  private async close(): Promise<void> {
    this.resolveReadyWait?.();
    this.readyCallbacks.clear();
    this.masterChangeCallbacks.clear();
    if (this.ownedClient) {
      this.ownedClient.off("ready", this.onReady);
      if (this.started) {
        await this.closeOwnedClient(this.ownedClient);
      }
    } else if (this.callerClient) {
      this.callerClient.off("ready", this.onReady);
    } else if (this.sentinel) {
      this.sentinel.off("ready", this.onReady);
      this.sentinel.off("topology-change", this.onTopologyChange);
    }
  }

  /**
   * 대기 중인 명령이 끝나기를 commandDeadlineMs까지만 기다리고, 그래도 남아 있으면 강제로 끊는다.
   * Redis가 응답하지 않으면 close()가 끝나지 않기 때문이다.
   */
  private async closeOwnedClient(client: RedisClientType): Promise<void> {
    if (!client.isOpen) {
      return;
    }
    try {
      await withDeadline(() => client.close(), this.options.commandDeadlineMs);
    } catch {
      client.destroy();
    }
  }

  private createOwnedClient(options: RedisClientOptions): RedisClientType {
    const client = createClient({
      ...options,
      // 오프라인이면 명령을 쌓지 않고 즉시 실패시켜 rebuild 대기로 넘긴다
      disableOfflineQueue: true,
      commandOptions: { ...options.commandOptions, timeout: this.options.commandDeadlineMs },
    });
    // 처리되지 않은 error 이벤트는 프로세스를 종료시키므로 반드시 리스너를 둔다
    client.on("error", ignoreError);
    return client;
  }

  private markReady(): void {
    this.everReady = true;
    const resolve = this.resolveReadyWait;
    this.resolveReadyWait = undefined;
    resolve?.();
  }

  private loadScript(commands: RedisCommandTarget, script: LuaScript): Promise<string> {
    const pending = this.scriptLoads.get(script.sha);
    if (pending) {
      return pending;
    }
    const loading = commands.scriptLoad(script.source).finally(() => {
      this.scriptLoads.delete(script.sha);
    });
    this.scriptLoads.set(script.sha, loading);
    return loading;
  }
}
