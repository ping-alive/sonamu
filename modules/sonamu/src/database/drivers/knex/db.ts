import _ from "lodash";
import { DBPreset, KnexBaseConfig, SonamuKnexDBConfig } from "../../types";
import knex, { Knex } from "knex";
import { KnexClient } from "./client";
import { DBClass } from "../../db.abstract";
import { attachOnDuplicateUpdate } from "./plugins/knex-on-duplicate-update";
import { KnexGenerator } from "./generator";

export class DBKnexClass extends DBClass {
  public migrationTable = "knex_migrations";
  public generator: KnexGenerator = new KnexGenerator();
  public baseConfig?: KnexBaseConfig;

  public declare _fullConfig?: SonamuKnexDBConfig;
  set fullConfig(config: SonamuKnexDBConfig) {
    this._fullConfig = config;
  }
  get fullConfig() {
    if (!this._fullConfig) {
      throw new Error("DB Config has not been initialized");
    }
    return this._fullConfig;
  }

  private wdb?: Knex;
  private rdb?: Knex;

  private _tdb: KnexClient | null = null;
  set tdb(tdb: KnexClient) {
    this._tdb = tdb;
  }
  get tdb(): KnexClient {
    if (this._tdb === null) {
      throw new Error("tdb has not been initialized");
    }
    return this._tdb;
  }

  private _fdb: KnexClient | null = null;
  set fdb(fdb: KnexClient) {
    this._fdb = fdb;
  }
  get fdb(): KnexClient {
    if (this._fdb === null) {
      throw new Error("fdb has not been initialized");
    }
    return this._fdb;
  }

  get connectionInfo() {
    return _.mapValues(this.fullConfig, ({ connection }) => ({
      host: connection.host ?? "localhost",
      port: connection.port ?? 3306,
      database: connection.database,
      user: connection.user,
      password: connection.password,
    }));
  }

  constructor() {
    super();
    attachOnDuplicateUpdate();
  }

  init(config: KnexBaseConfig) {
    this.baseConfig = config;
    this.fullConfig = this.generateDBConfig(config);
  }

  async testInit() {
    if (this._tdb !== null) {
      return;
    }

    if (this.fullConfig.test && this.fullConfig.production_master) {
      const tConn = this.connectionInfo.test;
      const pConn = this.connectionInfo.production_master;

      if (
        `${tConn.host ?? "localhost"}:${tConn.port ?? 3306}/${
          tConn.database
        }` ===
        `${pConn.host ?? "localhost"}:${pConn.port ?? 3306}/${pConn.database}`
      ) {
        throw new Error(
          `테스트DB와 프로덕션DB에 동일한 데이터베이스가 사용되었습니다.`
        );
      }
    }

    this.tdb = new KnexClient(this.fullConfig.test);
    this.fdb = new KnexClient(this.fullConfig.fixture_local);
  }

  getDB(which: DBPreset) {
    const instanceName = which === "w" ? "wdb" : "rdb";

    if (!this[instanceName]) {
      const config = this.getCurrentConfig(which);
      this[instanceName] = knex(config);
    }

    return this[instanceName]!;
  }

  getClient(mode: keyof SonamuKnexDBConfig) {
    return new KnexClient(this.fullConfig[mode]);
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

  raw(db: Knex, query: string) {
    return db.raw(query);
  }

  public generateDBConfig(config: KnexBaseConfig): SonamuKnexDBConfig {
    const defaultKnexConfig = _.merge(
      {
        client: "mysql2",
        pool: {
          min: 1,
          max: 5,
        },
        migrations: {
          extension: "js",
          directory: "./dist/migrations",
        },
        connection: {
          host: "localhost",
          port: 3306,
          database: config.database,
        },
      },
      config.defaultOptions
    );

    // 로컬 환경 설정
    const test = _.merge(
      {},
      defaultKnexConfig,
      {
        connection: {
          database: `${config.database}_test`,
        },
      },
      config.environments?.test
    );

    const fixture_local = _.merge({}, defaultKnexConfig, {
      connection: {
        database: `${config.database}_fixture`,
      },
    });

    // 개발 환경 설정
    const devMasterOptions = config.environments?.development;
    const devSlaveOptions = config.environments?.development_slave;
    const development_master = _.merge({}, defaultKnexConfig, devMasterOptions);
    const development_slave = _.merge(
      {},
      defaultKnexConfig,
      devMasterOptions,
      devSlaveOptions
    );
    const fixture_remote = _.merge({}, defaultKnexConfig, devMasterOptions, {
      connection: {
        database: `${config.database}_fixture`,
      },
    });

    // 프로덕션 환경 설정
    const prodMasterOptions = config.environments?.production ?? {};
    const prodSlaveOptions = config.environments?.production_slave ?? {};
    const production_master = _.merge({}, defaultKnexConfig, prodMasterOptions);
    const production_slave = _.merge(
      {},
      defaultKnexConfig,
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
  getUniqueConfigs(keys: (keyof SonamuKnexDBConfig)[]) {
    const targets = keys.map((key) => ({
      connKey: key,
      options: this.fullConfig[key as keyof SonamuKnexDBConfig],
    }));

    return _.uniqBy(targets, ({ options }) => {
      const conn = options.connection as Knex.ConnectionConfig & {
        port?: number;
      };

      return `${conn.host ?? "localhost"}:${conn.port ?? 3306}/${
        conn.database
      }`;
    });
  }
}
