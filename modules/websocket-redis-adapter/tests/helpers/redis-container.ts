import { execFile } from "node:child_process";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { promisify } from "node:util";

import { createClient, type RedisClientType } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

const execFileAsync = promisify(execFile);

export const REDIS_IMAGE = "redis:alpine";

export type StartedRedis = {
  container: StartedTestContainer;
  host: string;
  port: number;
  url: string;
  // 컨테이너를 일시정지해 이미 전송된 명령이 응답을 받지 못하는 상황을 만든다
  pause(): Promise<void>;
  unpause(): Promise<void>;
  // 테스트가 실패해도 일시정지 상태가 남지 않도록 afterEach에서 호출한다
  ensureUnpaused(): Promise<void>;
  stop(): Promise<void>;
};

export async function dockerPause(containerId: string): Promise<void> {
  await execFileAsync("docker", ["pause", containerId]);
}

export async function dockerUnpause(containerId: string): Promise<void> {
  await execFileAsync("docker", ["unpause", containerId]);
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  let paused = false;
  let stopped = false;

  return {
    container,
    host,
    port,
    url: `redis://${host}:${port}`,
    async pause() {
      await dockerPause(container.getId());
      paused = true;
    },
    async unpause() {
      await dockerUnpause(container.getId());
      paused = false;
    },
    async ensureUnpaused() {
      if (paused && !stopped) {
        await dockerUnpause(container.getId());
        paused = false;
      }
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (paused) {
        await dockerUnpause(container.getId()).catch(() => {});
        paused = false;
      }
      await container.stop();
    },
  };
}

export type RawRedisClient = RedisClientType;

/**
 * 어댑터와 무관하게 Redis 상태를 직접 읽는 검증용 클라이언트를 만든다.
 * keyPrefix 없이 실제 키 이름을 그대로 본다.
 */
export async function createRawClient(url: string): Promise<RawRedisClient> {
  const client: RawRedisClient = createClient({ url });
  client.on("error", () => {});
  await client.connect();
  return client;
}

export function nodeKeys(prefix: string, nodeId: string) {
  return {
    sessions: `${prefix}:{${nodeId}}:sessions`,
    rooms: `${prefix}:{${nodeId}}:rooms`,
    users: `${prefix}:{${nodeId}}:users`,
    namespaces: `${prefix}:{${nodeId}}:namespaces`,
    nodes: `${prefix}:nodes`,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * assertion이 통과할 때까지 짧은 간격으로 재시도한다.
 * 고정된 긴 sleep 대신 상한이 있는 polling으로 비동기 수렴을 기다린다.
 */
export async function eventually(
  assertion: () => void | Promise<void>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError ?? new Error(`eventually: ${timeoutMs}ms 안에 조건을 만족하지 못했습니다.`);
}

export type SettledTiming = {
  status: "fulfilled" | "rejected";
  elapsedMs: number;
  reason?: unknown;
};

// promise가 resolve/reject 어느 쪽으로든 끝나는 데 걸린 시간을 잰다
export async function timeSettle(promise: PromiseLike<unknown>): Promise<SettledTiming> {
  const startedAt = Date.now();
  try {
    await promise;
    return { status: "fulfilled", elapsedMs: Date.now() - startedAt };
  } catch (reason) {
    return { status: "rejected", elapsedMs: Date.now() - startedAt, reason };
  }
}

/**
 * promise가 timeoutMs 안에 끝나는지 확인한다. 끝나지 않으면 "pending"을 돌려준다.
 * 원래 promise의 rejection은 삼켜 unhandledRejection이 생기지 않게 한다.
 */
export async function settleWithin(
  promise: PromiseLike<unknown>,
  timeoutMs: number,
): Promise<"fulfilled" | "rejected" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), timeoutMs);
  });
  const settled = Promise.resolve(promise).then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );
  try {
    return await Promise.race([settled, pending]);
  } finally {
    clearTimeout(timer);
  }
}

export type CommandStat = { calls: number; failedCalls: number };

/**
 * INFO commandstats를 파싱한다. 키는 소문자 명령 이름이다 (예: "evalsha", "script|load").
 */
export async function readCommandStats(client: RawRedisClient): Promise<Map<string, CommandStat>> {
  const info = await client.info("commandstats");
  const stats = new Map<string, CommandStat>();
  for (const line of info.split(/\r?\n/)) {
    const match = /^cmdstat_([^:]+):(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const pair of match[2].split(",")) {
      const [key, value] = pair.split("=");
      fields.set(key, value);
    }
    stats.set(match[1], {
      calls: Number(fields.get("calls") ?? 0),
      failedCalls: Number(fields.get("failed_calls") ?? 0),
    });
  }
  return stats;
}

export function statOf(stats: Map<string, CommandStat>, command: string): CommandStat {
  return stats.get(command) ?? { calls: 0, failedCalls: 0 };
}

/**
 * 테스트 대상 외의 클라이언트(검증용 raw client 등)를 제외한 연결 목록을 돌려준다.
 */
export async function listClients(
  client: RawRedisClient,
): Promise<Array<{ id: string; name: string; flags: string; cmd: string }>> {
  const raw = await client.clientList();
  return raw.map((entry) => ({
    id: String(entry.id),
    name: entry.name ?? "",
    flags: entry.flags ?? "",
    cmd: entry.cmd ?? "",
  }));
}

/**
 * 검증용 raw client를 제외한 모든 연결을 끊는다. 어댑터 클라이언트 재연결을 유도할 때 쓴다.
 */
export async function killOtherClients(
  client: RawRedisClient,
  keepIds: string[] = [],
): Promise<number> {
  const selfId = String(await client.clientId());
  const keep = new Set([selfId, ...keepIds]);
  const clients = await listClients(client);
  let killed = 0;
  for (const entry of clients) {
    if (keep.has(entry.id)) {
      continue;
    }
    killed += Number(await client.sendCommand(["CLIENT", "KILL", "ID", entry.id]));
  }
  return killed;
}

/**
 * TCP 연결은 받아들이지만 아무 응답도 하지 않는 서버.
 * node-redis의 HELLO/handshake가 끝나지 않아 ready 상태에 도달하지 못하는 Redis를 흉내낸다.
 */
export async function startSilentTcpServer(): Promise<{
  port: number;
  url: string;
  // 지금까지 받아들인 TCP 연결 수
  acceptedCount(): number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server: Server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address =
    /* SAFETY: TCP 포트로 listen했으므로 AddressInfo가 반환된다. */ server.address() as AddressInfo;
  return {
    port: address.port,
    url: `redis://127.0.0.1:${address.port}`,
    acceptedCount: () => accepted,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// 테스트마다 키/채널이 겹치지 않도록 고유 접두사와 노드 ID를 만든다
let uniqueCounter = 0;
export function uniqueName(label: string): string {
  uniqueCounter += 1;
  return `${label}-${process.pid}-${Date.now().toString(36)}-${uniqueCounter}`;
}

export type MonitoredCommand = {
  // 명령을 보낸 쪽. 클라이언트 주소(host:port) 또는 Lua 스크립트 안에서 실행된 명령이면 "lua"
  source: string;
  // 소문자 명령 이름 (예: "evalsha", "hset")
  command: string;
  line: string;
};

// MONITOR 한 줄: 1700000000.123456 [0 172.17.0.1:54321] "evalsha" "..." / 스크립트 내부는 [0 lua]
// IPv6 주소는 [fd07::1]:54321처럼 대괄호를 포함하므로 '] "'까지를 source로 본다
const MONITOR_LINE = /^\S+ \[\d+ (.*?)\] "([^"]+)"/;

export function parseMonitorLine(line: string): MonitoredCommand | undefined {
  const match = MONITOR_LINE.exec(line);
  if (!match) {
    return undefined;
  }
  return { source: match[1], command: match[2].toLowerCase(), line };
}

/**
 * MONITOR로 Redis가 실행한 명령을 실행 순서대로 기록한다.
 * capture()는 시작/끝 표식(ECHO)을 보내 그 사이에 실행된 명령만 돌려준다.
 */
export async function startMonitor(url: string): Promise<{
  capture(action: () => Promise<void>): Promise<MonitoredCommand[]>;
  close(): Promise<void>;
}> {
  const lines: string[] = [];
  const monitorClient = createClient({ url });
  monitorClient.on("error", () => {});
  await monitorClient.connect();
  await monitorClient.monitor((reply) => {
    lines.push(reply);
  });
  const marker = await createRawClient(url);
  let sequence = 0;

  return {
    async capture(action) {
      sequence += 1;
      const startMarker = `monitor-start-${sequence}`;
      const endMarker = `monitor-end-${sequence}`;
      await marker.echo(startMarker);
      await action();
      await marker.echo(endMarker);
      let captured: MonitoredCommand[] = [];
      await eventually(() => {
        const startIndex = lines.findIndex((line) => line.includes(`"${startMarker}"`));
        const endIndex = lines.findIndex((line) => line.includes(`"${endMarker}"`));
        if (startIndex < 0 || endIndex < 0) {
          throw new Error("MONITOR 표식이 아직 도착하지 않았습니다.");
        }
        captured = lines
          .slice(startIndex + 1, endIndex)
          .map(parseMonitorLine)
          .filter((entry) => entry !== undefined);
      });
      return captured;
    },
    async close() {
      await marker.close().catch(() => {});
      monitorClient.destroy();
    },
  };
}

// 이 클라이언트가 Redis에 보이는 주소(MONITOR의 source와 같은 형식)
export async function clientAddressOf(client: RawRedisClient): Promise<string> {
  const info = await client.clientInfo();
  return info.addr;
}
