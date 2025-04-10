import _ from "lodash";
import { promises } from "fs";
import path from "path";
import { createPool } from "mysql2";
import {
  DBPreset,
  Database,
  KyselyBaseConfig,
  KyselyConfig,
  SonamuKyselyDBConfig,
} from "../../types";
import { FileMigrationProviderProps, Kysely, MysqlDialect, sql } from "kysely";
import { KyselyClient } from "./client";
import { DBClass } from "../../db.abstract";
import { Sonamu } from "../../../api";
import { KyselyGenerator } from "./generator";

export class DBKyselyClass extends DBClass {
  public migrationTable = "kysely_migration";
  public generator: KyselyGenerator = new KyselyGenerator();
  public baseConfig?: KyselyBaseConfig;

  public declare _fullConfig?: SonamuKyselyDBConfig;
  set fullConfig(config: SonamuKyselyDBConfig) {
    this._fullConfig = config;
  }
  get fullConfig() {
    if (!this._fullConfig) {
      throw new Error("DB Config has not been initialized");
    }
    return this._fullConfig;
  }

  private wdb?: Kysely<Database>;
  private rdb?: Kysely<Database>;

  private _tdb: KyselyClient | null = null;
  set tdb(tdb: KyselyClient) {
    this._tdb = tdb;
  }
  get tdb(): KyselyClient {
    if (this._tdb === null) {
      throw new Error("tdb has not been initialized");
    }
    return this._tdb;
  }

  private _fdb: KyselyClient | null = null;
  set fdb(fdb: KyselyClient) {
    this._fdb = fdb;
  }
  get fdb(): KyselyClient {
    if (this._fdb === null) {
      throw new Error("fdb has not been initialized");
    }
    return this._fdb;
  }

  get connectionInfo() {
    return _.mapValues(this.fullConfig, (config) => ({
      host: config.host ?? "localhost",
      port: config.port ?? 3306,
      database: config.database,
      user: config.user,
      password: config.password,
    }));
  }

  constructor() {
    super();
  }

  init(config: KyselyBaseConfig) {
    this.baseConfig = config;
    this.fullConfig = this.generateDBConfig(config);
  }

  async testInit() {
    if (this._tdb !== null) {
      return;
    }

    if (this.fullConfig.test && this.fullConfig.production_master) {
      const tConnInfo = this.fullConfig.test;
      const pConnInfo = this.fullConfig.production_master;

      if (
        `${tConnInfo.host ?? "localhost"}:${tConnInfo.port ?? 3306}/${
          tConnInfo.database
        }` ===
        `${pConnInfo.host ?? "localhost"}:${pConnInfo.port ?? 3306}/${pConnInfo.database}`
      ) {
        throw new Error(
          `테스트DB와 프로덕션DB에 동일한 데이터베이스가 사용되었습니다.`
        );
      }
    }

    this.tdb = new KyselyClient(this.fullConfig.test);
    this.fdb = new KyselyClient(this.fullConfig.fixture_local);
  }

  get config(): SonamuKyselyDBConfig {
    return this.fullConfig;
  }

  getDB(which: DBPreset) {
    const instanceName = which === "w" ? "wdb" : "rdb";

    if (!this[instanceName]) {
      const _config: KyselyConfig = this.getCurrentConfig(which);
      const { onCreateConnection, migration, ...config } = _config;

      this[instanceName] = new Kysely<Database>({
        dialect: new MysqlDialect({
          onCreateConnection,
          pool: createPool(config),
        }),
      });
    }

    return this[instanceName]!;
  }

  getClient(mode: keyof SonamuKyselyDBConfig) {
    return new KyselyClient(this.fullConfig[mode]);
  }

  async destroy(): Promise<void> {
    if (this.wdb !== undefined) {
      await this.wdb.destroy();
      this.wdb = undefined;
    }
    if (this.rdb !== undefined) {
      await this.rdb.destroy();
      this.rdb = undefined;
    }
  }

  async testDestroy() {
    if (this._tdb) {
      await this._tdb.destroy();
      this._tdb = null;
    }
    if (this._fdb) {
      await this._fdb.destroy();
      this._fdb = null;
    }
  }

  raw(db: Kysely<Database>, query: string) {
    return sql`${query}`.execute(db);
  }

  public generateDBConfig(config: KyselyBaseConfig): SonamuKyselyDBConfig {
    const defaultKyselyConfig = _.merge(
      {
        migration: {
          fs: promises,
          path,
          migrationFolder: path.join(Sonamu.apiRootPath, "/dist/migrations"),
        } as FileMigrationProviderProps,
        port: 3306,
        host: "localhost",
        database: config.database,
      },
      config.defaultOptions
    );

    // 로컬 환경 설정
    const test = _.merge({}, defaultKyselyConfig, {
      database: `${config.database}_test`,
    });

    const fixture_local = _.merge({}, defaultKyselyConfig, {
      database: `${config.database}_fixture`,
    });

    // 개발 환경 설정
    const devMasterOptions = config.environments?.development;
    const devSlaveOptions = config.environments?.development_slave;
    const development_master = _.merge(
      {},
      defaultKyselyConfig,
      devMasterOptions
    );
    const development_slave = _.merge(
      {},
      defaultKyselyConfig,
      devMasterOptions,
      devSlaveOptions
    );
    const fixture_remote = _.merge({}, defaultKyselyConfig, devMasterOptions, {
      database: `${config.database}_fixture`,
    });

    // 프로덕션 환경 설정
    const prodMasterOptions = config.environments?.production ?? {};
    const prodSlaveOptions = config.environments?.production_slave ?? {};
    const production_master = _.merge(
      {},
      defaultKyselyConfig,
      prodMasterOptions
    );
    const production_slave = _.merge(
      {},
      defaultKyselyConfig,
      prodMasterOptions,
      prodSlaveOptions
    );

    return {
      test,
      fixture_local,
      fixture_remote,
      development_master,
      development_slave,
      production_master,
      production_slave,
    };
  }

  /**
   * keys에 해당하는 설정들을 중복없이 가져옵니다. (host/port/database가 같은 설정은 중복으로 처리합니다.)
   */
  getUniqueConfigs(keys: (keyof SonamuKyselyDBConfig)[]) {
    const targets = keys.map((key) => ({
      connKey: key,
      options: this.fullConfig[key as keyof SonamuKyselyDBConfig],
    }));

    return _.uniqBy(
      targets,
      ({ options }) =>
        `${options.host ?? "localhost"}:${options.port ?? 3306}/${options.database}`
    );
  }
}
