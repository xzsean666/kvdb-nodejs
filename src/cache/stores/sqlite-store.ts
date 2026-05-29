// SQLite-backed KVStore for the cache subsystem (docs/SPEC.md §8).
//
// Backs the "sqlite-memory" (file = ":memory:") and "sqlite" (file on disk)
// cache drivers. It is a pure KVStore — no JSON query surface — kept separate
// from the SQLite *driver* (drivers/sqlite) so each file stays small and
// understandable in isolation.
//
// better-sqlite3 is loaded via createRequire at construction time, NOT a static
// import, so importing the Cache facade never requires better-sqlite3 unless a
// SQLite cache store is actually instantiated (it is an optional peer dep).

import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import type { KVStore, RawEntry, KVEntry } from "../types.js";
import { expiresAtFromTtl } from "../../core/expiry.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";

const require = createRequire(import.meta.url);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SqliteStoreOptions {
  /** File path, or ":memory:". Defaults to ":memory:". */
  file?: string;
  /** Physical table name. Defaults to "kvdb_cache". */
  table?: string;
}

export class SqliteCacheStore implements KVStore {
  private readonly database: BetterSqlite3.Database;
  private readonly table: string;
  private readonly statements: {
    get: BetterSqlite3.Statement;
    upsert: BetterSqlite3.Statement;
    delete: BetterSqlite3.Statement;
  };

  constructor(options: SqliteStoreOptions = {}) {
    const table = options.table ?? "kvdb_cache";
    if (!IDENTIFIER.test(table)) {
      throw new KvdbConfigError(`Invalid SQLite cache table name: ${JSON.stringify(table)}`);
    }
    this.table = table;

    let DatabaseCtor: typeof BetterSqlite3;
    try {
      DatabaseCtor = require("better-sqlite3") as typeof BetterSqlite3;
    } catch (cause) {
      throw new KvdbConnectionError(
        'The "better-sqlite3" package is required for SQLite cache stores. Install it with `pnpm add better-sqlite3`.',
        { cause },
      );
    }

    const file = options.file ?? ":memory:";
    this.database = new DatabaseCtor(file);
    this.database.pragma("case_sensitive_like = ON");
    if (file !== ":memory:") this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER
      );
    `);

    this.statements = {
      get: this.database.prepare(`SELECT value, expires_at FROM ${table} WHERE key = ?`),
      upsert: this.database.prepare(
        `INSERT INTO ${table} (key, value, expires_at) VALUES (@key, @value, @expiresAt)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
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
    this.statements.upsert.run({
      key,
      value,
      expiresAt: expiresAtFromTtl(ttlMs, Date.now()) ?? null,
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

  close(): void {
    this.database.close();
  }
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}
