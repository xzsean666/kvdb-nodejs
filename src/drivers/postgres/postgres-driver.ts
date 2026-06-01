// PostgreSQL driver — node-postgres (pg) backend (docs/ARCHITECTURE.md §3).
//
// Reuses the shared SQL compiler with a jsonb dialect — adding this backend is
// "one visitor", which is the payoff of KD-2. The value is stored as TEXT
// (canonical JSON) for exact round-trips and cast to jsonb for querying.
//
// Connection pooling belongs to pg, not to us (KD-6): we pass the connection
// string straight through to a pg Pool and never reimplement pooling. pg is an
// optional peer dependency, imported lazily in connect().

import type { Pool } from "pg";
import type {
  Driver,
  DriverFactory,
  DriverCapabilities,
  ProviderName,
  UpdateMutator,
} from "../types.js";
import type { KVEntry, RawEntry } from "../../cache/types.js";
import type { QueryNode, FindOptions } from "../../query/ast.js";
import { compileWhere, compileOrderBy } from "../../query/compiler.js";
import { parsePath } from "../../query/parser.js";
import { PostgresDialect } from "./dialect.js";
import { expiresAtFromTtl } from "../../core/expiry.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";

const PROVIDER: ProviderName = "postgres";

const CAPABILITIES: DriverCapabilities = {
  nativeTtl: false,
  jsonQuery: "pg-jsonb",
  managesOwnPool: true,
  supportsTransactions: true,
  supportsPrefixScan: true,
};

export interface PostgresDriverOptions {
  /** PostgreSQL connection string. */
  url: string;
  /** Physical table name. Defaults to "kvdb_kv". */
  table?: string;
  /**
   * JSON value paths to index when the table is created (e.g. ["profile.age"]).
   * Default: none — only the `key` primary key and the internal expires_at /
   * key-prefix indexes exist, so writes pay no JSON-index cost unless you opt in.
   */
  indexes?: string[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PostgresDriverFactory implements DriverFactory {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly options: PostgresDriverOptions) {
    if (!options.url) throw new KvdbConfigError("PostgreSQL driver requires a `url`.");
    if (options.table !== undefined && !IDENTIFIER.test(options.table)) {
      throw new KvdbConfigError(`Invalid table name: ${JSON.stringify(options.table)}`);
    }
  }

  async connect(): Promise<Driver> {
    let PoolCtor: typeof Pool;
    try {
      PoolCtor = (await import("pg")).default.Pool;
    } catch (cause) {
      throw new KvdbConnectionError(
        'The "pg" package is required for the PostgreSQL driver. Install it with `pnpm add pg`.',
        { cause },
      );
    }
    const pool = new PoolCtor({ connectionString: this.options.url });
    const table = this.options.table ?? "kvdb_kv";
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key        text PRIMARY KEY,
        value      text NOT NULL,
        expires_at bigint,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at);
      -- text_pattern_ops so prefix/namespace scans (key LIKE 'ns:%') use an
      -- index: the default PK btree is unusable for LIKE under non-C collations
      -- (e.g. en_US.UTF-8). See docs — verified via EXPLAIN against real PG.
      CREATE INDEX IF NOT EXISTS ${table}_key_prefix ON ${table} (key text_pattern_ops);
    `);
    const driver = new PostgresDriver(pool, table);
    for (const path of this.options.indexes ?? []) await driver.ensureIndex(path);
    return driver;
  }
}

class PostgresDriver implements Driver {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;
  private readonly dialect = new PostgresDialect("value");

  constructor(
    private readonly pool: Pool,
    private readonly table: string,
  ) {}

  async get(key: string): Promise<RawEntry | undefined> {
    const result = await this.pool.query<{ value: string; expires_at: string | null }>(
      `SELECT value, expires_at FROM ${this.table} WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      await this.delete(key);
      return undefined;
    }
    return { value: row.value, expiresAt };
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO ${this.table} (key, value, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [key, value, expiresAtFromTtl(ttlMs, now) ?? null, now],
    );
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
    return (result.rowCount ?? 0) > 0;
  }

  async update(key: string, mutate: UpdateMutator): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE locks the row for the txn, so a concurrent updater blocks here
      // until we COMMIT — they then read our write instead of clobbering it.
      const result = await client.query<{ value: string; expires_at: string | null }>(
        `SELECT value, expires_at FROM ${this.table} WHERE key = $1 FOR UPDATE`,
        [key],
      );
      const now = Date.now();
      let current: RawEntry | undefined;
      const row = result.rows[0];
      if (row !== undefined) {
        const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
        if (expiresAt !== undefined && expiresAt <= now) {
          await client.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
        } else {
          current = { value: row.value, expiresAt };
        }
      }
      const next = mutate(current);
      await client.query(
        `INSERT INTO ${this.table} (key, value, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (key) DO UPDATE SET
           value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
        [key, next.value, expiresAtFromTtl(next.ttlMs, now) ?? null, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table}`);
  }

  async getMany(keys: string[]): Promise<(RawEntry | undefined)[]> {
    if (keys.length === 0) return [];
    const result = await this.pool.query<{ key: string; value: string; expires_at: string | null }>(
      `SELECT key, value, expires_at FROM ${this.table} WHERE key = ANY($1)`,
      [keys],
    );
    const now = Date.now();
    const byKey = new Map<string, RawEntry>();
    for (const row of result.rows) {
      const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
      if (expiresAt !== undefined && expiresAt <= now) continue;
      byKey.set(row.key, { value: row.value, expiresAt });
    }
    return keys.map((key) => byKey.get(key));
  }

  async setMany(entries: KVEntry[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      for (const entry of entries) {
        await client.query(
          `INSERT INTO ${this.table} (key, value, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (key) DO UPDATE SET
             value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
          [entry.key, entry.value, expiresAtFromTtl(entry.ttlMs, now) ?? null, now],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE key = ANY($1)`, [keys]);
    return result.rowCount ?? 0;
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    const now = Date.now();
    const where =
      prefix === undefined
        ? `expires_at IS NULL OR expires_at > $1`
        : `key LIKE $1 AND (expires_at IS NULL OR expires_at > $2)`;
    const params = prefix === undefined ? [now] : [`${escapeLike(prefix)}%`, now];
    const result = await this.pool.query<{ key: string; value: string; expires_at: string | null }>(
      `SELECT key, value, expires_at FROM ${this.table} WHERE ${where}`,
      params,
    );
    for (const row of result.rows) {
      yield [
        row.key,
        { value: row.value, expiresAt: row.expires_at === null ? undefined : Number(row.expires_at) },
      ];
    }
  }

  async getByPrefix(prefix: string): Promise<KVEntry[]> {
    const result = await this.pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.table}
       WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > $2)`,
      [`${escapeLike(prefix)}%`, Date.now()],
    );
    return result.rows.map((row) => ({ key: row.key, value: row.value }));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE key LIKE $1`, [
      `${escapeLike(prefix)}%`,
    ]);
    return result.rowCount ?? 0;
  }

  async find(where: QueryNode, options: FindOptions = {}, keyPrefix?: string): Promise<KVEntry[]> {
    const compiled = compileWhere(where, this.dialect);
    const params: unknown[] = [...compiled.params];
    const nowIndex = params.push(Date.now());

    let sql = `SELECT key, value FROM ${this.table}
       WHERE (expires_at IS NULL OR expires_at > $${nowIndex}) AND (${compiled.sql})`;
    if (keyPrefix) {
      sql += ` AND key LIKE $${params.push(`${escapeLike(keyPrefix)}%`)}`;
    }
    if (options.sort && options.sort.length > 0) {
      sql += ` ORDER BY ${compileOrderBy(options.sort, this.dialect)}`;
    }
    if (options.limit !== undefined) sql += ` LIMIT $${params.push(options.limit)}`;
    if (options.offset !== undefined) sql += ` OFFSET $${params.push(options.offset)}`;

    const result = await this.pool.query<{ key: string; value: string }>(sql, params);
    return result.rows.map((row) => ({ key: row.key, value: row.value }));
  }

  async ensureIndex(jsonPath: string): Promise<void> {
    const path = parsePath(jsonPath);
    const safe = jsonPath.replace(/[^A-Za-z0-9]/g, "_");
    // Two expression indexes: a TEXT one for string equality / $in / sort, and a
    // NULL-safe NUMERIC one (CASE jsonb_typeof) for numeric range/eq. Queries
    // pick the cast that matches the comparison value, so both shapes stay
    // index-backed; the numeric index never fails to build on mixed-type rows.
    const textExpr = this.dialect.scalarAt(path);
    const numericExpr = this.dialect.scalarAt(path, 0);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_json_${safe} ON ${this.table} ((${textExpr}))`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_json_${safe}_num ON ${this.table} ((${numericExpr}))`,
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE expires_at IS NOT NULL AND expires_at <= $1`,
      [Date.now()],
    );
    return result.rowCount ?? 0;
  }

  raw(): Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}
