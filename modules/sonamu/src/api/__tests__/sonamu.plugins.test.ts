import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SonamuFastifyConfig } from "../../types/types";
import { isNumberValue, isObjectValue } from "../../utils/runtime-value";
import { type SonamuConfig, type SonamuServerOptions } from "../config";
import { type Context } from "../context";
import { type ExtendedApi } from "../decorators";
import { Sonamu } from "../sonamu";

const LARGE_VALUE = "sonamu-compress-".repeat(1024);

type HttpResponse = {
  statusCode: number | undefined;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
};

type SonamuWithBoot = typeof Sonamu & {
  boot(server: FastifyInstance, options: SonamuServerOptions): Promise<void>;
};

const sonamuWithBoot =
  /* SAFETY: 테스트에서 프로세스 시그널을 등록하는 private boot만 격리합니다. */ Sonamu as SonamuWithBoot;

function createApi(methodName: string, options: ExtendedApi["options"] = {}): ExtendedApi {
  return {
    modelName: "PayloadModel",
    methodName,
    path: `/payload/${methodName}`,
    options: {
      httpMethod: "GET",
      contentType: "application/json",
      ...options,
    },
    typeParameters: [],
    parameters: [],
    returnType: "unknown",
  };
}

const apis: ExtendedApi[] = [
  createApi("large"),
  createApi("largeWithoutCompression", { compress: false }),
];

const apiConfig: SonamuFastifyConfig = {
  contextProvider(defaultContext) {
    return /* SAFETY: 실제 HTTP 요청에서 생성된 기본 컨텍스트를 변경하지 않고 사용합니다. */ defaultContext as Context;
  },
  guardHandler() {},
};

function requestServer(
  server: FastifyInstance,
  options: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<HttpResponse> {
  const address = server.server.address();
  if (!isObjectValue(address) || !("port" in address) || !isNumberValue(address.port)) {
    throw new Error("테스트 서버의 TCP 주소를 확인할 수 없습니다");
  }

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("Sonamu 서버 플러그인 등록 순서", () => {
  const originalSnapshot = Sonamu.captureTestingSnapshot();
  const originalIsInitialized = Sonamu.isInitialized;
  const originalForTesting = Sonamu.forTesting;
  const originalServer = Sonamu.server;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHot = process.env.HOT;
  const servers: FastifyInstance[] = [];
  const tempRoots: string[] = [];
  let apiRootPath: string;

  beforeEach(async () => {
    process.env.NODE_ENV = "production";
    delete process.env.HOT;
    Sonamu.isInitialized = true;
    Sonamu.forTesting = false;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sonamu-plugin-registration-"));
    tempRoots.push(tempRoot);
    apiRootPath = path.join(tempRoot, "api");
    Reflect.set(Sonamu, "apiRootPathValue", apiRootPath);
    Reflect.set(Sonamu, "syncerValue", {
      apis,
      models: {
        PayloadModel: {
          large: () => ({ value: LARGE_VALUE }),
          largeWithoutCompression: () => ({ value: LARGE_VALUE }),
        },
      },
      types: {},
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    try {
      await Promise.allSettled(servers.splice(0).map(async (server) => await server.close()));
    } finally {
      Sonamu.restoreTestingSnapshot(originalSnapshot);
      Sonamu.isInitialized = originalIsInitialized;
      Sonamu.forTesting = originalForTesting;
      Sonamu.server = originalServer;
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalHot === undefined) {
        delete process.env.HOT;
      } else {
        process.env.HOT = originalHot;
      }
      await Promise.all(
        tempRoots.splice(0).map(async (tempRoot) => {
          await rm(tempRoot, { recursive: true, force: true });
        }),
      );
      vi.restoreAllMocks();
    }
  });

  async function createProductionServer(
    plugins: SonamuServerOptions["plugins"],
  ): Promise<FastifyInstance> {
    const config: SonamuConfig = {
      api: { dir: "src", route: { prefix: "/api" } },
      i18n: { defaultLocale: "ko", supportedLocales: ["ko"] },
      sync: { targets: [] },
      validation: { zodCompiler: false },
      database: {},
      logging: false,
      server: {
        plugins,
        apiConfig,
      },
    };
    Reflect.set(Sonamu, "configValue", config);
    vi.spyOn(sonamuWithBoot, "boot").mockResolvedValue(undefined);

    const server = await Sonamu.createServer({ enableSync: false, doSilent: true });
    servers.push(server);
    await server.listen({ host: "127.0.0.1", port: 0 });
    return server;
  }

  it("운영 서버에서 compress: true이면 JSON 응답을 gzip으로 압축한다", async () => {
    const server = await createProductionServer({ compress: true });

    const response = await requestServer(server, {
      path: "/api/payload/large",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(response.body).toString())).toEqual({ value: LARGE_VALUE });
  });

  it("운영 서버에서 API별 compress: false는 압축하지 않는다", async () => {
    const server = await createProductionServer({ compress: true });

    const optedOut = await requestServer(server, {
      path: "/api/payload/largeWithoutCompression",
      headers: { "accept-encoding": "gzip" },
    });

    expect(optedOut.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(optedOut.body.toString())).toEqual({ value: LARGE_VALUE });
  });
});
