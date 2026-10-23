import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DB } from "../../database/db";
import { EntityManager } from "../../entity/entity-manager";
import * as envModule from "../../env";
import { drivers } from "../../storage/drivers";
import { Syncer } from "../../syncer/syncer";
import { TemplateManager } from "../../template";
import { type AbsolutePath } from "../../utils/path-utils";
import * as utils from "../../utils/utils";
import * as configModule from "../config";
import { type SonamuConfig } from "../config";
import { Sonamu } from "../sonamu";

// 스토리지 자체는 실제 FS 드라이버로 검증하고 DB·모델 자동 로딩만 격리한다.
describe("서버 없이 스토리지 초기화", () => {
  const snapshot = Sonamu.captureTestingSnapshot();
  const originalInitialized = Sonamu.isInitialized;
  const originalForTesting = Sonamu.forTesting;
  const originalServer = Sonamu.server;
  const originalStorage = Sonamu["storageValue"];
  const originalCache = Sonamu["cacheValue"];
  const originalWorkflows = Sonamu["workflowsValue"];
  const originalDbConfig = Sonamu["dbConfigValue"];
  const originalBoot = Sonamu["boot"];
  const originalInitializeWorkflows = Sonamu["initializeWorkflows"];

  let config: SonamuConfig;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    Sonamu.isInitialized = false;
    Reflect.set(Sonamu, "storageValue", null);
    config = {
      projectName: "storage-test",
      api: { dir: "api", route: { prefix: "/api" } },
      database: {},
      i18n: { defaultLocale: "ko", supportedLocales: ["ko"] },
      sync: { targets: [] },
      logging: false,
      server: {
        apiConfig: {
          contextProvider: (context) => context,
          guardHandler: () => {},
        },
      },
    };
    vi.spyOn(configModule, "loadConfig").mockImplementation(async () => config);
    vi.spyOn(envModule, "readAllEnvironmentSnapshots").mockReturnValue({
      development: {},
      test: {},
      staging: {},
      production: {},
    });
    vi.spyOn(DB, "setConfig").mockImplementation(() => {});
    vi.spyOn(EntityManager, "autoload").mockResolvedValue(undefined);
    vi.spyOn(Syncer.prototype, "autoloadTypes").mockResolvedValue(undefined);
    vi.spyOn(Syncer.prototype, "autoloadModels").mockResolvedValue(undefined);
    vi.spyOn(Syncer.prototype, "autoloadApis").mockResolvedValue(undefined);
    vi.spyOn(Syncer.prototype, "autoloadWorkflows").mockResolvedValue(undefined);
    vi.spyOn(Syncer.prototype, "autoloadSsrRoutes").mockResolvedValue(undefined);
    vi.spyOn(TemplateManager, "autoload").mockResolvedValue(undefined);
    // 워크플로 초기화는 별도 DB 연결을 만들므로 스토리지 수명주기 검사에서 제외한다.
    Sonamu["initializeWorkflows"] = async () => {};
    // SAFETY: 테스트에서만 쓰는 절대 경로이며 파일 접근은 위의 설정·자동 로딩 경계에서 격리한다.
    vi.spyOn(utils, "findApiRootPath").mockReturnValue(
      "/tmp/sonamu-storage-test/api" as AbsolutePath,
    );
  });

  afterEach(async () => {
    if (Sonamu.server && Sonamu.server !== originalServer) await Sonamu.server.close();
    Sonamu.restoreTestingSnapshot(snapshot);
    Sonamu.isInitialized = originalInitialized;
    Sonamu.forTesting = originalForTesting;
    Sonamu.server = originalServer;
    Reflect.set(Sonamu, "storageValue", originalStorage);
    Reflect.set(Sonamu, "cacheValue", originalCache);
    Reflect.set(Sonamu, "workflowsValue", originalWorkflows);
    Reflect.set(Sonamu, "dbConfigValue", originalDbConfig);
    Sonamu["boot"] = originalBoot;
    Sonamu["initializeWorkflows"] = originalInitializeWorkflows;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function configureStorage() {
    const factory = vi.fn(
      drivers.fs({
        location: tmpdir(),
        visibility: "public",
        urlBuilder: {
          async generateURL(key) {
            return `https://cdn.example.com/${key}`;
          },
          async generateSignedURL(key) {
            return `https://cdn.example.com/${key}?signed`;
          },
        },
      }),
    );
    config.server.storage = { drivers: { images: factory } };
    return factory;
  }

  it.each(["init", "initForTesting"] as const)(
    "%s에서 디스크 생성 없이 설정을 준비하고 URL을 만든다",
    async (method) => {
      const factory = configureStorage();
      if (method === "init") await Sonamu.init(true, false);
      else await Sonamu.initForTesting();

      const storage = Sonamu.storage;
      expect(factory).not.toHaveBeenCalled();
      const disk = storage.use("images");
      expect(await disk.getUrl("photo.jpg")).toBe("https://cdn.example.com/photo.jpg");
      expect(await disk.getSignedUrl("photo.jpg")).toBe("https://cdn.example.com/photo.jpg?signed");
      expect(storage.use("images")).toBe(disk);
      expect(factory).toHaveBeenCalledTimes(1);
      await Sonamu.init(true, false);
      expect(Sonamu.storage).toBe(storage);
    },
  );

  it("설정이 없으면 기존 초기화 오류를 유지한다", async () => {
    await Sonamu.initForTesting();
    expect(() => Sonamu.storage).toThrow("Storage has not been initialized");
  });

  it("init 다음 서버를 생성해도 기존 디스크 인스턴스를 유지한다", async () => {
    const factory = configureStorage();
    await Sonamu.init(true, false);
    const storage = Sonamu.storage;
    const disk = storage.use("images");
    vi.spyOn(Sonamu, "withFastify").mockResolvedValue(undefined);
    // 실제 listen과 프로세스 종료 훅만 격리한다.
    Sonamu["boot"] = async () => {};
    await Sonamu.createServer({ doSilent: true });
    expect(Sonamu.storage).toBe(storage);
    expect(Sonamu.storage.use("images")).toBe(disk);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
