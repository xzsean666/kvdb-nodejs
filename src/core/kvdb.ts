// KVDB — a single database instance (docs/SPEC.md §2, docs/ARCHITECTURE.md §3).
//
// Responsibilities: choose a driver factory from config, connect lazily (the
// first operation triggers connection — no explicit connect() required), hand
// Tables a resolver for the connected driver, own the optional shared cache,
// and tear everything down on close().
//
// Multiple KVDB instances coexist independently (db1, db2): each owns its own
// factory, connection, and cache.

import type { Driver, DriverFactory } from "../drivers/types.js";
import { SqliteDriverFactory } from "../drivers/sqlite/sqlite-driver.js";
import { PostgresDriverFactory } from "../drivers/postgres/postgres-driver.js";
import { Cache } from "../cache/cache.js";
import type { CacheOptions } from "../cache/cache.js";
import { Table } from "./table.js";
import { HookRuntime } from "../plugins/runtime.js";
import type { Plugin } from "../plugins/types.js";
import type { JsonValue } from "../types/json.js";
import { KvdbConfigError } from "./errors.js";

/** Driver names accepted in config (mirrors docs/SPEC.md and the README). */
export type KVDBDriverName = "sqlite" | "postgresql" | "mongodb";

export interface KVDBOptions {
  driver: KVDBDriverName;
  /** Connection string (Postgres/Mongo) or file path (SQLite). */
  url?: string;
  /** Prefix applied to every physical key/table. Default "". */
  tablePrefix?: string;
  /** SQLite physical table name. Default "kvdb_kv". */
  table?: string;
  /** Optional cache: pass options to build one, or a pre-built Cache instance. */
  cache?: CacheOptions | Cache;
  /** Plugins registered at construction; their hooks fire on every Table op. */
  plugins?: Plugin[];
}

export interface TableOptions {
  /** Per-table cache; overrides the instance cache for this namespace. */
  cache?: CacheOptions | Cache;
}

export class KVDB {
  private readonly factory: DriverFactory;
  private readonly tablePrefix: string;
  private readonly cache: Cache | undefined;
  private readonly hooks: HookRuntime;
  private driverPromise: Promise<Driver> | undefined;

  constructor(options: KVDBOptions) {
    this.factory = createDriverFactory(options);
    this.tablePrefix = options.tablePrefix ?? "";
    this.cache = options.cache ? toCache(options.cache) : undefined;
    this.hooks = new HookRuntime();
    for (const plugin of options.plugins ?? []) this.hooks.register(plugin);
  }

  /** Create a namespaced Table. Values are typed via the `Value` parameter. */
  table<Value = JsonValue>(namespace: string, options: TableOptions = {}): Table<Value> {
    const cache = options.cache ? toCache(options.cache) : this.cache;
    return new Table<Value>({
      getDriver: () => this.getDriver(),
      scope: { tablePrefix: this.tablePrefix, namespace },
      cache,
      hooks: this.hooks,
    });
  }

  /** Force the connection to open now (otherwise it opens on first use). */
  async connect(): Promise<void> {
    await this.getDriver();
  }

  /** Native driver handle escape hatch (e.g. better-sqlite3 Database). */
  async raw(): Promise<unknown> {
    return (await this.getDriver()).raw();
  }

  async close(): Promise<void> {
    if (this.driverPromise === undefined) return;
    const driver = await this.driverPromise;
    this.driverPromise = undefined;
    await driver.close();
  }

  /** Lazily connect once; subsequent callers await the same connection. */
  private getDriver(): Promise<Driver> {
    if (this.driverPromise === undefined) {
      this.driverPromise = this.factory.connect();
    }
    return this.driverPromise;
  }
}

function createDriverFactory(options: KVDBOptions): DriverFactory {
  switch (options.driver) {
    case "sqlite":
      return new SqliteDriverFactory({ url: options.url, table: options.table });
    case "postgresql":
      if (options.url === undefined) {
        throw new KvdbConfigError("The PostgreSQL driver requires a connection `url`.");
      }
      return new PostgresDriverFactory({ url: options.url, table: options.table });
    case "mongodb":
      throw new KvdbConfigError(
        "The MongoDB driver is not implemented yet (see docs/nextsession.md backlog #10).",
      );
    default: {
      const unknown: never = options.driver;
      throw new KvdbConfigError(`Unknown driver: ${JSON.stringify(unknown)}`);
    }
  }
}

function toCache(value: CacheOptions | Cache): Cache {
  return value instanceof Cache ? value : new Cache(value);
}
