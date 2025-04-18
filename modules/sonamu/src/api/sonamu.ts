import chalk from "chalk";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IncomingMessage, Server, ServerResponse } from "http";
import { ZodError } from "zod";
import path from "path";
import fs from "fs-extra";
import { getZodObjectFromApi } from "./code-converters";
import { Context } from "./context";
import { BadRequestException } from "../exceptions/so-exceptions";
import { EntityManager } from "../entity/entity-manager";
import { fastifyCaster } from "./caster";
import { ApiParam, ApiParamType } from "../types/types";
import { Syncer } from "../syncer/syncer";
import { isLocal, isTest } from "../utils/controller";
import { findApiRootPath } from "../utils/utils";
import { ApiDecoratorOptions } from "./decorators";
import { humanizeZodError } from "../utils/zod-error";
import { DatabaseDriver, SonamuDBConfig } from "../database/types";
import { DB } from "../database/db";
import { AsyncLocalStorage } from "async_hooks";

export type SonamuConfig = {
  projectName?: string;
  api: {
    dir: string;
  };
  sync: {
    targets: string[];
  };
  route: {
    prefix: string;
  };
};
export type SonamuSecrets = {
  [key: string]: string;
};
type SonamuFastifyConfig = {
  contextProvider: (
    defaultContext: Pick<Context, "headers" | "reply">,
    request: FastifyRequest,
    reply: FastifyReply
  ) => Context;
  guardHandler: (
    guard: string,
    request: FastifyRequest,
    api: {
      typeParameters: ApiParamType.TypeParam[];
      parameters: ApiParam[];
      returnType: ApiParamType;
      modelName: string;
      methodName: string;
      path: string;
      options: ApiDecoratorOptions;
    }
  ) => void;
  cache?: {
    get: (key: string) => Promise<unknown | null>;
    put: (key: string, value: unknown, ttl?: number) => Promise<void>;
    resolveKey: (
      path: string,
      reqBody: {
        [key: string]: unknown;
      }
    ) =>
      | {
          cache: false;
        }
      | {
          cache: true;
          key: string;
          ttl?: number;
        };
  };
};
class SonamuClass {
  public isInitialized: boolean = false;
  public asyncLocalStorage: AsyncLocalStorage<{
    context: Context;
  }> = new AsyncLocalStorage();

  public getContext(): Context {
    const store = this.asyncLocalStorage.getStore();
    if (store?.context) {
      return store.context;
    }
    throw new Error("Sonamu cannot find context");
  }

  private _apiRootPath: string | null = null;
  set apiRootPath(apiRootPath: string) {
    this._apiRootPath = apiRootPath;
  }
  get apiRootPath(): string {
    if (this._apiRootPath === null) {
      throw new Error("Sonamu has not been initialized");
    }
    return this._apiRootPath!;
  }
  get appRootPath(): string {
    return this.apiRootPath.split(path.sep).slice(0, -1).join(path.sep);
  }

  private _dbConfig: SonamuDBConfig | null = null;
  set dbConfig(dbConfig: SonamuDBConfig) {
    this._dbConfig = dbConfig;
  }
  get dbConfig() {
    if (this._dbConfig === null) {
      throw new Error("Sonamu has not been initialized");
    }
    return this._dbConfig!;
  }

  private _dbClient: DatabaseDriver | null = null;
  set dbClient(_dbClient: DatabaseDriver) {
    this._dbClient = _dbClient;
  }
  get dbClient() {
    if (this._dbClient === null) {
      throw new Error("Sonamu has not been initialized");
    }
    return this._dbClient!;
  }

  private _syncer: Syncer | null = null;
  set syncer(syncer: Syncer) {
    this._syncer = syncer;
  }
  get syncer(): Syncer {
    if (this._syncer === null) {
      throw new Error("Sonamu has not been initialized");
    }
    return this._syncer!;
  }

  private _config: SonamuConfig | null = null;
  set config(config: SonamuConfig) {
    this._config = config;
  }
  get config(): SonamuConfig {
    if (this._config === null) {
      throw new Error("Sonamu has not been initialized");
    }
    return this._config;
  }

  private _secrets: SonamuSecrets | null = null;
  set secrets(secrets: SonamuSecrets) {
    this._secrets = secrets;
  }
  get secrets(): SonamuSecrets | null {
    return this._secrets;
  }

  async initForTesting() {
    await this.init(true, false, undefined, true);
  }

  async init(
    doSilent: boolean = false,
    enableSync: boolean = true,
    apiRootPath?: string,
    forTesting: boolean = false
  ) {
    if (this.isInitialized) {
      return;
    }
    !doSilent &&
      console.time(
        chalk.cyan(`Sonamu.init${forTesting ? " for testing" : ""}`)
      );

    // API 루트 패스
    this.apiRootPath = apiRootPath ?? (await findApiRootPath());
    const configPath = path.join(this.apiRootPath, "sonamu.config.json");
    const secretsPath = path.join(this.apiRootPath, "sonamu.secrets.json");
    if (fs.existsSync(configPath) === false) {
      throw new Error(`Cannot find sonamu.config.json in ${configPath}`);
    }
    this.config = JSON.parse(
      fs.readFileSync(configPath).toString()
    ) as SonamuConfig;
    if (fs.existsSync(secretsPath)) {
      this.secrets = JSON.parse(
        fs.readFileSync(secretsPath).toString()
      ) as SonamuSecrets;
    }

    // DB 로드
    const baseConfig = await DB.getBaseConfig(this.apiRootPath);
    this.dbClient = baseConfig.client;
    DB.init(baseConfig as any);
    this.dbConfig = DB.fullConfig;

    // 테스팅인 경우 엔티티 로드 & 싱크 없이 중단
    if (forTesting) {
      this.isInitialized = true;
      return;
    }

    // Entity 로드
    await EntityManager.autoload(doSilent);

    // Syncer
    this.syncer = new Syncer();

    // Autoload: Models / Types / APIs
    await this.syncer.autoloadModels();
    await this.syncer.autoloadTypes();
    await this.syncer.autoloadApis();

    if (isLocal() && !isTest() && enableSync) {
      await this.syncer.sync();

      fetch("http://127.0.0.1:57001/api/reload", {
        method: "GET",
      }).catch((e) =>
        console.log(chalk.dim(`Failed to reload Sonamu UI: ${e.message}`))
      );
    }

    this.isInitialized = true;
    !doSilent && console.timeEnd(chalk.cyan("Sonamu.init"));
  }

  async withFastify(
    server: FastifyInstance<Server, IncomingMessage, ServerResponse>,
    config: SonamuFastifyConfig,
    options?: {
      enableSync?: boolean;
      doSilent?: boolean;
    }
  ) {
    if (this.isInitialized === false) {
      await this.init(options?.doSilent, options?.enableSync);
    }

    // 전체 라우팅 리스트
    server.get(
      `${this.config.route.prefix}/routes`,
      async (_request, _reply): Promise<any> => {
        return this.syncer.apis;
      }
    );

    // Healthcheck API
    server.get(
      `${this.config.route.prefix}/healthcheck`,
      async (_request, _reply): Promise<string> => {
        return "ok";
      }
    );

    // API 라우팅 등록
    this.syncer.apis.map((api) => {
      // model
      if (this.syncer.models[api.modelName] === undefined) {
        throw new Error(`정의되지 않은 모델에 접근 ${api.modelName}`);
      }
      const model = this.syncer.models[api.modelName];

      // 파라미터 정보로 zod 스키마 빌드
      const ReqType = getZodObjectFromApi(api, this.syncer.types);

      // route
      server.route({
        method: api.options.httpMethod!,
        url: this.config.route.prefix + api.path,
        handler: async (request, reply): Promise<unknown> => {
          (api.options.guards ?? []).every((guard) =>
            config.guardHandler(guard, request, api)
          );

          // request 파싱
          const which = api.options.httpMethod === "GET" ? "query" : "body";
          let reqBody: {
            [key: string]: unknown;
          };
          try {
            reqBody = fastifyCaster(ReqType).parse(request[which] ?? {});
          } catch (e) {
            if (e instanceof ZodError) {
              const messages = humanizeZodError(e)
                .map((issue) => issue.message)
                .join(" ");
              throw new BadRequestException(messages);
            } else {
              throw e;
            }
          }

          // Content-Type
          reply.type(api.options.contentType ?? "application/json");

          // 캐시
          const { cacheKey, cacheTtl, cachedData } = await (async () => {
            if (config.cache) {
              try {
                const cacheKeyRes = config.cache.resolveKey(api.path, reqBody);
                if (cacheKeyRes.cache === false) {
                  return { cacheKey: null, cachedData: null };
                }

                const cacheKey = cacheKeyRes.key;
                const cacheTtl = cacheKeyRes.ttl;
                const cachedData = await config.cache.get(cacheKey);
                return { cacheKey, cacheTtl, cachedData };
              } catch (e) {
                console.error(e);
              }
              return { cacheKey: null, cachedData: null };
            }
            return { cacheKey: null, cachedData: null };
          })();
          if (cachedData !== null) {
            return cachedData;
          }

          // 결과 (AsyncLocalStorage 적용)
          const context = config.contextProvider(
            {
              headers: request.headers,
              reply,
            },
            request,
            reply
          );
          return this.asyncLocalStorage.run({ context }, async () => {
            const result = await (model as any)[api.methodName].apply(
              model,
              api.parameters.map((param) => {
                // Context 인젝션
                if (ApiParamType.isContext(param.type)) {
                  return context;
                } else {
                  return reqBody[param.name];
                }
              })
            );
            reply.type(api.options.contentType ?? "application/json");

            // 캐시 키 있는 경우 갱신 후 저장
            if (config.cache && cacheKey) {
              await config.cache.put(cacheKey, result, cacheTtl);
            }
            return result;
          });
        },
      }); // END server.route
    });
  }

  async destroy(): Promise<void> {
    await DB.destroy();
  }
}
export const Sonamu = new SonamuClass();
