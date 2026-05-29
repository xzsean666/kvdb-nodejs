// SQLite driver — better-sqlite3 backend (docs/ARCHITECTURE.md §3, §5.2).
//
// Synchronous and in-process: the fastest way to use SQLite (no thread-pool
// hop). All keys arriving here are already physical (core/key.ts); this driver
// does no key rewriting. SQLite has no native TTL, so expiry is enforced here
// via an `expires_at` column filtered on every read.
//
// better-sqlite3 is an optional peer dependency: it is imported lazily in the
// factory's connect(), so installing only the backends you use stays valid.

import type BetterSqlite3 from "better-sqlite3";
import type { Driver, DriverFactory, DriverCapabilities, ProviderName } from "../types.js";
import type { KVEntry, RawEntry } from "../../cache/types.js";
import type { QueryNode, FindOptions } from "../../query/ast.js";
import { compileWhere, compileOrderBy } from "../../query/compiler.js";
import { parsePath } from "../../query/parser.js";
import { SqliteDialect } from "./dialect.js";
import { expiresAtFromTtl } from "../../core/expiry.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";

const PROVIDER: ProviderName = "sqlite";

const CAPABILITIES: DriverCapabilities = {
  nativeTtl: false,
  jsonQuery: "sqlite-json",
  managesOwnPool: false,
  supportsTransactions: true,
  supportsPrefixScan: true,
};

export interface SqliteDriverOptions {
  /** File path, or ":memory:" for an in-memory database. Defaults to ":memory:". */
  url?: string;
  /** Physical table name. Defaults to "kvdb_kv". */
  table?: string;
  /**
   * JSON value paths to index when the table is created (e.g. ["profile.age"]).
   * Default: none — only the `key` primary key and the expires_at index exist.
   */
  indexes?: string[];
}

export class SqliteDriverFactory implements DriverFactory {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly options: SqliteDriverOptions = {}) {}

  async connect(): Promise<Driver> {
    let DatabaseCtor: typeof BetterSqlite3;
    try {
      DatabaseCtor = (await import("better-sqlite3")).default;
    } catch (cause) {
      throw new KvdbConnectionError(
        'The "better-sqlite3" package is required for the SQLite driver. Install it with `pnpm add better-sqlite3`.',
        { cause },
      );
    }
    const file = this.options.url ?? ":memory:";
    const database = new DatabaseCtor(file);
    const driver = new SqliteDriver(database, file, this.options.table ?? "kvdb_kv");
    for (const path of this.options.indexes ?? []) driver.ensureIndex(path);
    return driver;
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

class SqliteDriver implements Driver {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;

  private readonly dialect: SqliteDialect;
  private readonly statements: {
    get: BetterSqlite3.Statement;
    upsert: BetterSqlite3.Statement;
    delete: BetterSqlite3.Statement;
  };

  constructor(
    private readonly database: BetterSqlite3.Database,
    file: string,
    private readonly table: string,
  ) {
    if (!IDENTIFIER.test(table)) {
      throw new KvdbConfigError(`Invalid SQLite table name: ${JSON.stringify(table)}`);
    }
    this.dialect = new SqliteDialect("value");

    this.database.pragma("case_sensitive_like = ON");
    if (file !== ":memory:") this.database.pragma("journal_mode = WAL");

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at);
    `);

    this.statements = {
      get: this.database.prepare(`SELECT value, expires_at FROM ${table} WHERE key = ?`),
      upsert: this.database.prepare(
        `INSERT INTO ${table} (key, value, expires_at, created_at, updated_at)
         VALUES (@key, @value, @expiresAt, @now, @now)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      ),
      delete: this.database.prepare(`DELETE FROM ${table} WHERE key = ?`),
    };
  }

  get(key: string): RawEntry | undefined {
    const row = this.statements.get.get(key) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (row === undefined) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.statements.delete.run(key);
      return undefined;
    }
    return { value: row.value, expiresAt: row.expires_at ?? undefined };
  }

  set(key: string, value: string, ttlMs?: number): void {
    const now = Date.now();
    this.statements.upsert.run({
      key,
      value,
      expiresAt: expiresAtFromTtl(ttlMs, now) ?? null,
      now,
    });
  }

  delete(key: string): boolean {
    return this.statements.delete.run(key).changes > 0;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.database.exec(`DELETE FROM ${this.table}`);
  }

  getMany(keys: string[]): (RawEntry | undefined)[] {
    return keys.map((key) => this.get(key));
  }

  setMany(entries: KVEntry[]): void {
    const writeAll = this.database.transaction((items: KVEntry[]) => {
      for (const entry of items) this.set(entry.key, entry.value, entry.ttlMs);
    });
    writeAll(entries);
  }

  deleteMany(keys: string[]): number {
    const deleteAll = this.database.transaction((items: string[]) => {
      let count = 0;
      for (const key of items) if (this.delete(key)) count++;
      return count;
    });
    return deleteAll(keys);
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    const now = Date.now();
    const where =
      prefix === undefined
        ? "expires_at IS NULL OR expires_at > ?"
        : `key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?)`;
    const params = prefix === undefined ? [now] : [`${escapeLike(prefix)}%`, now];
    const statement = this.database.prepare(
      `SELECT key, value, expires_at FROM ${this.table} WHERE ${where}`,
    );
    for (const row of statement.iterate(...params) as Iterable<{
      key: string;
      value: string;
      expires_at: number | null;
    }>) {
      yield [row.key, { value: row.value, expiresAt: row.expires_at ?? undefined }];
    }
  }

  getByPrefix(prefix: string): KVEntry[] {
    const rows = this.database
      .prepare(
        `SELECT key, value FROM ${this.table}
         WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(`${escapeLike(prefix)}%`, Date.now()) as { key: string; value: string }[];
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  deleteByPrefix(prefix: string): number {
    return this.database
      .prepare(`DELETE FROM ${this.table} WHERE key LIKE ? ESCAPE '\\'`)
      .run(`${escapeLike(prefix)}%`).changes;
  }

  find(where: QueryNode, options: FindOptions = {}, keyPrefix?: string): KVEntry[] {
    const compiled = compileWhere(where, this.dialect);
    const clauses = [`(expires_at IS NULL OR expires_at > ?)`, `(${compiled.sql})`];
    const params: unknown[] = [Date.now(), ...compiled.params];
    if (keyPrefix) {
      clauses.push(`key LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLike(keyPrefix)}%`);
    }

    let sql = `SELECT key, value FROM ${this.table} WHERE ${clauses.join(" AND ")}`;
    if (options.sort && options.sort.length > 0) {
      sql += ` ORDER BY ${compileOrderBy(options.sort, this.dialect)}`;
    }
    if (options.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      sql += options.limit === undefined ? ` LIMIT -1 OFFSET ?` : ` OFFSET ?`;
      params.push(options.offset);
    }

    const rows = this.database.prepare(sql).all(...params) as { key: string; value: string }[];
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  ensureIndex(jsonPath: string): void {
    const path = parsePath(jsonPath);
    const expression = this.dialect.scalarAt(path);
    const indexName = `${this.table}_json_${jsonPath.replace(/[^A-Za-z0-9]/g, "_")}`;
    this.database.exec(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${this.table} (${expression})`,
    );
  }

  purgeExpired(): number {
    return this.database
      .prepare(`DELETE FROM ${this.table} WHERE expires_at IS NOT NULL AND expires_at <= ?`)
      .run(Date.now()).changes;
  }

  raw(): BetterSqlite3.Database {
    return this.database;
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

/** Escape LIKE wildcards so a user prefix is matched literally (ESCAPE '\'). */
function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}
