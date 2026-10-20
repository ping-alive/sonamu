import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createClient, createSentinel, type RedisSentinelType } from "redis";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

import { createRawClient, eventually, type RawRedisClient, REDIS_IMAGE } from "./redis-container";

export const SENTINEL_MASTER_NAME = "sonamu-master";

const MASTER_ALIAS = "redis-master";
const REPLICA_ALIAS = "redis-replica";
const SENTINEL_ALIAS = "redis-sentinel";

const execFileAsync = promisify(execFile);

export type RedisNodeAddress = { host: string; port: number };

export type SentinelTopology = {
  network: StartedNetwork;
  master: StartedTestContainer;
  replica: StartedTestContainer;
  sentinel: StartedTestContainer;
  sentinelRootNodes: RedisNodeAddress[];
  // 컨테이너 내부 주소(IP/alias:6379)를 호스트에 매핑된 포트로 바꾼다
  nodeAddressMap: (address: string) => RedisNodeAddress | undefined;
  // 호출자가 소유하는 Sentinel 클라이언트를 만든다 (연결은 호출자가 한다)
  // scanInterval 기본값은 500ms. 0이면 주기적 topology scan을 끈다
  createSentinelClient(options?: { keyPrefix?: string; scanInterval?: number }): RedisSentinelType;
  // Sentinel이 현재 master로 알고 있는 노드의 호스트 매핑 주소
  currentMaster(): Promise<RedisNodeAddress>;
  /**
   * Sentinel이 알려 주는(컨테이너 내부) 주소 형식. node-redis의 실제 MASTER_CHANGE 이벤트는 이 형식을 싣는다.
   * current는 SENTINEL GET-MASTER-ADDR-BY-NAME 결과, other는 나머지 노드다.
   */
  announcedAddresses(): Promise<{ current: RedisNodeAddress; other: RedisNodeAddress }>;
  // 현재 master에 직접 붙는 검증용 raw client (호출자가 close한다)
  connectToCurrentMaster(): Promise<RawRedisClient>;
  // SENTINEL FAILOVER로 master를 바꾸고, 새 master가 쓰기를 받을 때까지 기다린다
  failover(): Promise<{ previous: RedisNodeAddress; next: RedisNodeAddress }>;
  stop(): Promise<void>;
};

// Sentinel 명령 응답은 문자열 또는 (중첩) 배열이다
type SentinelReply = string | number | null | SentinelReply[];

async function sentinelCommand(address: RedisNodeAddress, args: string[]): Promise<SentinelReply> {
  const client = createClient({ socket: { host: address.host, port: address.port } });
  client.on("error", () => {});
  await client.connect();
  try {
    return /* SAFETY: Sentinel 명령은 문자열/정수/배열만 응답한다. */ (await client.sendCommand(
      args,
    )) as SentinelReply;
  } finally {
    await client.close();
  }
}

/**
 * master 1, replica 1, sentinel 1개로 구성된 Sentinel 토폴로지를 testcontainers Network 위에 띄운다.
 * Sentinel은 컨테이너 내부 IP를 알려주므로 nodeAddressMap으로 호스트 포트에 매핑한다.
 */
export async function startSentinelTopology(): Promise<SentinelTopology> {
  const network = await new Network().start();
  const started: StartedTestContainer[] = [];
  try {
    const master = await new GenericContainer(REDIS_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(MASTER_ALIAS)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    started.push(master);

    const replica = await new GenericContainer(REDIS_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(REPLICA_ALIAS)
      .withExposedPorts(6379)
      .withCommand(["redis-server", "--replicaof", MASTER_ALIAS, "6379"])
      .withWaitStrategy(Wait.forLogMessage("MASTER <-> REPLICA sync: Finished with success"))
      .start();
    started.push(replica);

    const masterIp = master.getIpAddress(network.getName());
    const replicaIp = replica.getIpAddress(network.getName());
    const sentinelConfig = [
      "port 26379",
      `sentinel monitor ${SENTINEL_MASTER_NAME} ${masterIp} 6379 1`,
      `sentinel down-after-milliseconds ${SENTINEL_MASTER_NAME} 1000`,
      `sentinel failover-timeout ${SENTINEL_MASTER_NAME} 5000`,
      `sentinel parallel-syncs ${SENTINEL_MASTER_NAME} 1`,
      "",
    ].join("\n");

    const sentinel = await new GenericContainer(REDIS_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(SENTINEL_ALIAS)
      .withExposedPorts(26379)
      .withCopyContentToContainer([
        { content: sentinelConfig, target: "/data/sentinel.conf", mode: 0o666 },
      ])
      .withCommand(["redis-server", "/data/sentinel.conf", "--sentinel"])
      .withWaitStrategy(Wait.forLogMessage("+monitor master"))
      .start();
    started.push(sentinel);

    const mapped = new Map<string, RedisNodeAddress>([
      [`${masterIp}:6379`, { host: master.getHost(), port: master.getMappedPort(6379) }],
      [`${MASTER_ALIAS}:6379`, { host: master.getHost(), port: master.getMappedPort(6379) }],
      [`${replicaIp}:6379`, { host: replica.getHost(), port: replica.getMappedPort(6379) }],
      [`${REPLICA_ALIAS}:6379`, { host: replica.getHost(), port: replica.getMappedPort(6379) }],
      [
        `${sentinel.getIpAddress(network.getName())}:26379`,
        { host: sentinel.getHost(), port: sentinel.getMappedPort(26379) },
      ],
    ]);
    const nodeAddressMap = (address: string) => mapped.get(address);
    const sentinelAddress = { host: sentinel.getHost(), port: sentinel.getMappedPort(26379) };

    const currentMaster = async (): Promise<RedisNodeAddress> => {
      const reply =
        /* SAFETY: SENTINEL GET-MASTER-ADDR-BY-NAME은 [ip, port]를 반환한다. */ (await sentinelCommand(
          sentinelAddress,
          ["SENTINEL", "GET-MASTER-ADDR-BY-NAME", SENTINEL_MASTER_NAME],
        )) as [string, string];
      const address = mapped.get(`${reply[0]}:${reply[1]}`);
      if (!address) {
        throw new Error(`매핑되지 않은 master 주소입니다: ${reply.join(":")}`);
      }
      return address;
    };

    const connectToCurrentMaster = async (): Promise<RawRedisClient> => {
      const address = await currentMaster();
      return createRawClient(`redis://${address.host}:${address.port}`);
    };

    // Sentinel이 replica를 발견해야 SENTINEL FAILOVER가 가능하다
    await eventually(
      async () => {
        const replicas = await sentinelCommand(sentinelAddress, [
          "SENTINEL",
          "REPLICAS",
          SENTINEL_MASTER_NAME,
        ]);
        if (!Array.isArray(replicas) || replicas.length < 1) {
          throw new Error("Sentinel이 아직 replica를 발견하지 못했습니다.");
        }
      },
      { timeoutMs: 30_000, intervalMs: 200 },
    );

    return {
      network,
      master,
      replica,
      sentinel,
      sentinelRootNodes: [sentinelAddress],
      nodeAddressMap,
      createSentinelClient(options = {}) {
        const client = createSentinel({
          name: SENTINEL_MASTER_NAME,
          sentinelRootNodes: [sentinelAddress],
          nodeAddressMap,
          scanInterval: options.scanInterval ?? 500,
          // keyPrefix가 undefined면 node-redis는 접두사를 붙이지 않는다
          keyPrefix: options.keyPrefix,
        });
        client.on("error", () => {});
        return client;
      },
      currentMaster,
      async announcedAddresses() {
        const reply = await sentinelCommand(sentinelAddress, [
          "SENTINEL",
          "GET-MASTER-ADDR-BY-NAME",
          SENTINEL_MASTER_NAME,
        ]);
        if (!Array.isArray(reply) || reply.length !== 2) {
          throw new Error(`예상하지 못한 master 주소 응답입니다: ${JSON.stringify(reply)}`);
        }
        const current = { host: String(reply[0]), port: Number(reply[1]) };
        const otherHost = current.host === masterIp ? replicaIp : masterIp;
        return { current, other: { host: otherHost, port: 6379 } };
      },
      connectToCurrentMaster,
      async failover() {
        const previous = await currentMaster();
        const waitForNewMaster = async (): Promise<RedisNodeAddress> => {
          let next = previous;
          await eventually(
            async () => {
              next = await currentMaster();
              if (next.port === previous.port && next.host === previous.host) {
                throw new Error("아직 failover가 끝나지 않았습니다.");
              }
              const client = await createRawClient(`redis://${next.host}:${next.port}`);
              try {
                const role = await client.sendCommand(["ROLE"]);
                if (!Array.isArray(role) || String(role[0]) !== "master") {
                  throw new Error("새 master가 아직 master 역할이 아닙니다.");
                }
              } finally {
                await client.close();
              }
            },
            { timeoutMs: 6_000, intervalMs: 200 },
          );
          return next;
        };

        // topology를 띄운 직후에는 Sentinel이 replica INFO를 아직 받지 못해 -failover-abort-no-good-slave로
        // 중단될 수 있으므로, master가 바뀔 때까지 FAILOVER를 다시 요청한다
        const deadline = Date.now() + 60_000;
        let lastError: Error = new Error("failover를 시도하지 않았습니다.");
        while (Date.now() < deadline) {
          // 진행 중(INPROG)이거나 replica가 아직 준비되지 않은 오류는 다음 시도에서 다시 확인한다
          await sentinelCommand(sentinelAddress, [
            "SENTINEL",
            "FAILOVER",
            SENTINEL_MASTER_NAME,
          ]).catch(() => null);
          try {
            return { previous, next: await waitForNewMaster() };
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }
        // failover가 끝나지 않은 원인을 알 수 있도록 Sentinel 로그 끝부분을 붙인다
        const { stdout } = await execFileAsync("docker", [
          "logs",
          "--tail",
          "40",
          sentinel.getId(),
        ]);
        throw new Error(`failover가 끝나지 않았습니다. Sentinel 로그:\n${stdout}`, {
          cause: lastError,
        });
      },
      async stop() {
        for (const container of started.toReversed()) {
          await container.stop().catch(() => {});
        }
        await network.stop().catch(() => {});
      },
    };
  } catch (error) {
    for (const container of started.toReversed()) {
      await container.stop().catch(() => {});
    }
    await network.stop().catch(() => {});
    throw error;
  }
}
