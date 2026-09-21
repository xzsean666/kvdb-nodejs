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
  UpdateResult,
  SchemaTableDriver,
} from "../types.js";
import type { KVEntry, RawEntry } from "../../cache/types.js";
import type { QueryNode, FindOptions } from "../../query/ast.js";
import { compileWhere, compileOrderBy } from "../../query/compiler.js";
import { parsePath } from "../../query/parser.js";
import { PostgresDialect } from "./dialect.js";
import { expiresAtFromTtl } from "../../core/expiry.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";
import {
  validateTableSchema,
  schemasEqual,
  evolveSchemaAddKey,
  evolveSchemaAddIndex,
  normalizeTableSchema,
} from "../../core/table-schema.js";
import type {
  TableSchema,
  MultiKeySchema,
  KeyDefinition,
  TableIndexDefinition,
  MultiKeyIndexDefinition,
  NormalizedSchema,
} from "../../core/table-schema.js";


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
      CREATE TABLE IF NOT EXISTS "${table}" (
        "key"        text PRIMARY KEY,
        "value"      text NOT NULL,
        "expires_at" bigint,
        "created_at" bigint NOT NULL,
        "updated_at" bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "${table}_expires_at" ON "${table}" ("expires_at");
      -- text_pattern_ops so prefix/namespace scans (key LIKE 'ns:%') use an
      -- index: the default PK btree is unusable for LIKE under non-C collations
      -- (e.g. en_US.UTF-8). See docs — verified via EXPLAIN against real PG.
      CREATE INDEX IF NOT EXISTS "${table}_key_prefix" ON "${table}" ("key" text_pattern_ops);
    `);
    const driver = new PostgresDriver(pool, table);
    for (const path of this.options.indexes ?? []) await driver.ensureIndex(path);
    return driver;
  }
}

export class PostgresDriver implements Driver {

  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;
  private readonly dialect = new PostgresDialect("value");

  constructor(
    private readonly pool: Pool,
    private readonly table: string,
  ) {}

  async get(key: string): Promise<RawEntry | undefined> {
    const result = await this.pool.query<{ value: string; expires_at: string | null }>(
      `SELECT "value", "expires_at" FROM "${this.table}" WHERE "key" = $1`,
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
      `INSERT INTO "${this.table}" ("key", "value", "expires_at", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT ("key") DO UPDATE SET
         "value" = excluded."value", "expires_at" = excluded."expires_at", "updated_at" = excluded."updated_at"`,
      [key, value, expiresAtFromTtl(ttlMs, now) ?? null, now],
    );
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM "${this.table}" WHERE "key" = $1`, [key]);
    return (result.rowCount ?? 0) > 0;
  }

  async update(key: string, mutate: UpdateMutator): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE locks the row for the txn, so a concurrent updater blocks here
      // until we COMMIT — they then read our write instead of clobbering it.
      const result = await client.query<{ value: string; expires_at: string | null }>(
        `SELECT "value", "expires_at" FROM "${this.table}" WHERE "key" = $1 FOR UPDATE`,
        [key],
      );
      const now = Date.now();
      let current: RawEntry | undefined;
      const row = result.rows[0];
      if (row !== undefined) {
        const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
        if (expiresAt !== undefined && expiresAt <= now) {
          await client.query(`DELETE FROM "${this.table}" WHERE "key" = $1`, [key]);
        } else {
          current = { value: row.value, expiresAt };
        }
      }
      const next = mutate(current);
      await client.query(
        `INSERT INTO "${this.table}" ("key", "value", "expires_at", "created_at", "updated_at")
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT ("key") DO UPDATE SET
           "value" = excluded."value", "expires_at" = excluded."expires_at", "updated_at" = excluded."updated_at"`,
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
    await this.pool.query(`DELETE FROM "${this.table}"`);
  }

  async getMany(keys: string[]): Promise<(RawEntry | undefined)[]> {
    if (keys.length === 0) return [];
    const result = await this.pool.query<{ key: string; value: string; expires_at: string | null }>(
      `SELECT "key", "value", "expires_at" FROM "${this.table}" WHERE "key" = ANY($1)`,
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
          `INSERT INTO "${this.table}" ("key", "value", "expires_at", "created_at", "updated_at")
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT ("key") DO UPDATE SET
             "value" = excluded."value", "expires_at" = excluded."expires_at", "updated_at" = excluded."updated_at"`,
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
    const result = await this.pool.query(`DELETE FROM "${this.table}" WHERE "key" = ANY($1)`, [keys]);
    return result.rowCount ?? 0;
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    const CHUNK_SIZE = 500;
    let lastKey: string | undefined = undefined;
    const now = Date.now();

    while (true) {
      const params: unknown[] = [now];
      const clauses: string[] = ['("expires_at" IS NULL OR "expires_at" > $1)'];

      if (prefix !== undefined) {
        params.push(`${escapeLike(prefix)}%`);
        clauses.push(`"key" LIKE $${params.length}`);
      }

      if (lastKey !== undefined) {
        params.push(lastKey);
        clauses.push(`"key" > $${params.length}`);
      }

      params.push(CHUNK_SIZE);
      const sql = `SELECT "key", "value", "expires_at" FROM "${this.table}"
        WHERE ${clauses.join(" AND ")}
        ORDER BY "key" ASC
        LIMIT $${params.length}`;

      const result = await this.pool.query<{ key: string; value: string; expires_at: string | null }>(
        sql,
        params,
      );

      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        yield [
          row.key,
          { value: row.value, expiresAt: row.expires_at === null ? undefined : Number(row.expires_at) },
        ];
        lastKey = row.key;
      }

      if (result.rows.length < CHUNK_SIZE) break;
    }
  }

  async getByPrefix(prefix: string): Promise<KVEntry[]> {
    const result = await this.pool.query<{ key: string; value: string }>(
      `SELECT "key", "value" FROM "${this.table}"
       WHERE "key" LIKE $1 AND ("expires_at" IS NULL OR "expires_at" > $2)`,
      [`${escapeLike(prefix)}%`, Date.now()],
    );
    return result.rows.map((row) => ({ key: row.key, value: row.value }));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM "${this.table}" WHERE "key" LIKE $1`, [
      `${escapeLike(prefix)}%`,
    ]);
    return result.rowCount ?? 0;
  }

  async find(where: QueryNode, options: FindOptions = {}, keyPrefix?: string): Promise<KVEntry[]> {
    const compiled = compileWhere(where, this.dialect);
    const params: unknown[] = [...compiled.params];
    const nowIndex = params.push(Date.now());

    let sql = `SELECT "key", "value" FROM "${this.table}"
       WHERE ("expires_at" IS NULL OR "expires_at" > $${nowIndex}) AND (${compiled.sql})`;
    if (keyPrefix) {
      sql += ` AND "key" LIKE $${params.push(`${escapeLike(keyPrefix)}%`)}`;
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
    const textExpr = this.dialect.scalarAt(path);
    const numericExpr = this.dialect.scalarAt(path, 0);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS "${this.table}_json_${safe}" ON "${this.table}" ((${textExpr}))`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS "${this.table}_json_${safe}_num" ON "${this.table}" ((${numericExpr}))`,
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM "${this.table}" WHERE "expires_at" IS NOT NULL AND "expires_at" <= $1`,
      [Date.now()],
    );
    let total = result.rowCount ?? 0;

    try {
      const regCheck = await this.pool.query(
        "SELECT to_regclass('kvdb_schema_registry') AS exists",
      );
      if (regCheck.rows[0]?.exists) {
        const regRows = await this.pool.query<{ logical_name: string }>(
          "SELECT logical_name FROM kvdb_schema_registry",
        );
        const now = Date.now();
        for (const r of regRows.rows) {
          if (r.logical_name) {
            const phys = schemaTableName(r.logical_name);
            try {
              const res = await this.pool.query(
                `DELETE FROM "${phys}" WHERE "expires_at" IS NOT NULL AND "expires_at" <= $1`,
                [now],
              );
              total += res.rowCount ?? 0;
            } catch {
              // Ignore if dropped
            }
          }
        }
      }
    } catch {
      // Ignore registry error
    }

    return total;
  }

  async openSchemaTable<Columns extends Record<string, unknown>>(
    name: string,
    schema?: TableSchema<Columns> | MultiKeySchema<Columns>,
  ): Promise<SchemaTableDriver<unknown, Columns> | undefined> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS kvdb_schema_registry (logical_name TEXT PRIMARY KEY, schema_json TEXT NOT NULL)",
    );
    const existingResult = await this.pool.query<{ schema_json: string }>(
      "SELECT schema_json FROM kvdb_schema_registry WHERE logical_name = $1",
      [name],
    );
    const existing = existingResult.rows[0];
    if (existing && schema && !schemasEqual(JSON.parse(existing.schema_json) as TableSchema, schema)) {
      throw new KvdbConfigError(`Schema conflict for table ${name}`);
    }
    const resolved = (schema ?? (existing ? JSON.parse(existing.schema_json) : undefined)) as TableSchema<Columns> | undefined;
    if (!resolved) return undefined;
    validateTableSchema(resolved);
    const norm = normalizeTableSchema(resolved);
    const physical = schemaTableName(name);

    if (!existing) {
      const pkSql = `"${norm.primaryKey.name}" ${norm.primaryKey.type === "integer" ? "BIGINT PRIMARY KEY" : "TEXT PRIMARY KEY"}`;
      const definitions = Object.entries(norm.keys)
        .map(([column, definition]) => `"${column}" ${pgType(definition.type)}${definition.nullable === false ? " NOT NULL" : ""}${definition.default !== undefined ? ` DEFAULT ${pgDefault(definition.default)}` : ""}`)
        .join(",\n");
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS "${physical}" (
          ${pkSql},
          ${definitions}${definitions ? "," : ""}
          "value" TEXT NOT NULL,
          "expires_at" BIGINT,
          "created_at" BIGINT NOT NULL,
          "updated_at" BIGINT NOT NULL
        )
      `);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS "${physical}_expires_at" ON "${physical}" ("expires_at")`);
      await this.pool.query(
        "INSERT INTO kvdb_schema_registry (logical_name, schema_json) VALUES ($1, $2) ON CONFLICT (logical_name) DO NOTHING",
        [name, JSON.stringify(resolved)],
      );
      for (const [column, definition] of Object.entries(norm.keys)) {
        if (definition.index) {
          const idxOpts = typeof definition.index === "object" ? definition.index : {};
          const idxName = idxOpts.name ?? `${physical}_${column}_idx`;
          await this.pool.query(`CREATE ${idxOpts.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${idxName}" ON "${physical}" ("${column}")`);
        }
      }
      for (const index of norm.indexes) {
        const idxName = index.name ?? `${physical}_${index.keys.join("_")}_idx`;
        await this.pool.query(
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${idxName}" ON "${physical}" (${index.keys.map((c) => `"${c}"`).join(", ")})`,
        );
      }

    }
    return new PostgresSchemaTable(this.pool, physical, name, resolved);
  }

  raw(): Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresSchemaTable<Columns extends Record<string, unknown>> implements SchemaTableDriver<unknown, Columns> {
  schema: TableSchema<Columns>;

  constructor(
    private readonly pool: Pool,
    private readonly table: string,
    private readonly logicalName: string,
    schema: TableSchema<Columns>,
  ) {
    this.schema = schema;
  }

  private get pkName(): string {
    return this.schema.primaryKey?.name ?? "key";
  }

  private get secondaryKeys(): Record<string, KeyDefinition> {
    return (this.schema.keys ?? this.schema.columns ?? {}) as Record<string, KeyDefinition>;
  }

  async setRecord(key: string | number, value: string, columns: Record<string, unknown>, ttlMs?: number): Promise<void> {
    const pk = this.pkName;
    const names = Object.keys(this.secondaryKeys);
    const now = Date.now();
    const fields = [pk, ...names, "value", "expires_at", "created_at", "updated_at"];
    const params: unknown[] = [key];

    for (const name of names) {
      const val = columns[name];
      const def = this.secondaryKeys[name]!;
      if (val === undefined) {
        params.push(def.default !== undefined ? def.default : null);
      } else if (def.type === "json") {
        params.push(JSON.stringify(val));
      } else {
        params.push(val);
      }
    }

    params.push(value);
    params.push(expiresAtFromTtl(ttlMs, now) ?? null);
    params.push(now);
    params.push(now);

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
    const updateClauses = [...names, "value", "expires_at", "updated_at"]
      .map((field) => `"${field}" = EXCLUDED."${field}"`)
      .join(", ");

    const sql = `INSERT INTO "${this.table}" (${fields.map((f) => `"${f}"`).join(", ")})
      VALUES (${placeholders})
      ON CONFLICT ("${pk}") DO UPDATE SET ${updateClauses}`;

    await this.pool.query(sql, params);
  }

  async setRecords(
    items: Array<{
      key: string | number;
      value: string;
      columns: Record<string, unknown>;
      ttlMs?: number;
    }>,
  ): Promise<void> {
    if (items.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const pk = this.pkName;
      const names = Object.keys(this.secondaryKeys);
      const fields = [pk, ...names, "value", "expires_at", "created_at", "updated_at"];
      const updateClauses = [...names, "value", "expires_at", "updated_at"]
        .map((field) => `"${field}" = EXCLUDED."${field}"`)
        .join(", ");
      const now = Date.now();

      const CHUNK_SIZE = 200;
      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        const chunk = items.slice(i, i + CHUNK_SIZE);
        const params: unknown[] = [];
        const valueTuples: string[] = [];

        for (const item of chunk) {
          const tuplePlaceholders: string[] = [];
          params.push(item.key);
          tuplePlaceholders.push(`$${params.length}`);

          for (const name of names) {
            const val = item.columns[name];
            const def = this.secondaryKeys[name]!;
            if (val === undefined) {
              params.push(def.default !== undefined ? def.default : null);
            } else if (def.type === "json") {
              params.push(JSON.stringify(val));
            } else {
              params.push(val);
            }
            tuplePlaceholders.push(`$${params.length}`);
          }

          params.push(item.value);
          tuplePlaceholders.push(`$${params.length}`);
          params.push(expiresAtFromTtl(item.ttlMs, now) ?? null);
          tuplePlaceholders.push(`$${params.length}`);
          params.push(now);
          tuplePlaceholders.push(`$${params.length}`);
          params.push(now);
          tuplePlaceholders.push(`$${params.length}`);

          valueTuples.push(`(${tuplePlaceholders.join(", ")})`);
        }

        const sql = `INSERT INTO "${this.table}" (${fields.map((f) => `"${f}"`).join(", ")})
          VALUES ${valueTuples.join(",\n")}
          ON CONFLICT ("${pk}") DO UPDATE SET ${updateClauses}`;

        await client.query(sql, params);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRecord(key: string | number): Promise<{ key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined> {
    const pk = this.pkName;
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM "${this.table}" WHERE "${pk}" = $1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) return undefined;

    const expiry = row.expires_at === null ? null : Number(row.expires_at);
    if (expiry !== null && expiry <= Date.now()) {
      await this.delete(key);
      return undefined;
    }

    return {
      key: this.parsePk(row[pk]),
      value: row.value as string,
      columns: this.parseColumns(row),
      expiresAt: expiry ?? undefined,
    };
  }

  async getRecordByKey(keyName: string, keyValue: unknown): Promise<{ key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined> {
    const pk = this.pkName;
    if (keyName === pk) {
      return this.getRecord(keyValue as string | number);
    }
    const def = this.secondaryKeys[keyName];
    if (!def) {
      throw new KvdbConfigError(`Unknown key: ${keyName}`);
    }

    const param = keyValue === null || keyValue === undefined ? null
      : def.type === "json" ? JSON.stringify(keyValue)
      : keyValue;

    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM "${this.table}" WHERE "${keyName}" = $1`,
      [param],
    );
    const row = result.rows[0];
    if (!row) return undefined;

    const expiry = row.expires_at === null ? null : Number(row.expires_at);
    if (expiry !== null && expiry <= Date.now()) {
      await this.delete(this.parsePk(row[pk]));
      return undefined;
    }

    return {
      key: this.parsePk(row[pk]),
      value: row.value as string,
      columns: this.parseColumns(row),
      expiresAt: expiry ?? undefined,
    };
  }

  async updateRecord(
    key: string | number,
    mutate: (current: { key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined) => UpdateResult,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const pk = this.pkName;
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM "${this.table}" WHERE "${pk}" = $1 FOR UPDATE`,
        [key],
      );
      const row = result.rows[0];
      const now = Date.now();
      let current: { key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined;
      if (row) {
        const expiry = row.expires_at === null ? null : Number(row.expires_at);
        if (expiry !== null && expiry <= now) {
          await client.query(`DELETE FROM "${this.table}" WHERE "${pk}" = $1`, [key]);
        } else {
          current = {
            key: this.parsePk(row[pk]),
            value: row.value as string,
            columns: this.parseColumns(row),
            expiresAt: expiry ?? undefined,
          };
        }
      }
      const next = mutate(current);
      const names = Object.keys(this.secondaryKeys);
      const fields = [pk, ...names, "value", "expires_at", "created_at", "updated_at"];
      const params: unknown[] = [key];
      const cols = current ? current.columns : {};
      for (const name of names) {
        const val = cols[name];
        const def = this.secondaryKeys[name]!;
        if (val === undefined) {
          params.push(def.default !== undefined ? def.default : null);
        } else if (def.type === "json") {
          params.push(JSON.stringify(val));
        } else {
          params.push(val);
        }
      }
      params.push(next.value);
      params.push(expiresAtFromTtl(next.ttlMs, now) ?? null);
      params.push(now);
      params.push(now);

      const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
      const updateClauses = [...names, "value", "expires_at", "updated_at"]
        .map((field) => `"${field}" = EXCLUDED."${field}"`)
        .join(", ");

      await client.query(
        `INSERT INTO "${this.table}" (${fields.map((f) => `"${f}"`).join(", ")})
         VALUES (${placeholders})
         ON CONFLICT ("${pk}") DO UPDATE SET ${updateClauses}`,
        params,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(key: string | number): Promise<boolean> {
    const pk = this.pkName;
    const result = await this.pool.query(
      `DELETE FROM "${this.table}" WHERE "${pk}" = $1`,
      [key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteRecords(keys: (string | number)[]): Promise<number> {
    if (keys.length === 0) return 0;
    const pk = this.pkName;
    const result = await this.pool.query(
      `DELETE FROM "${this.table}" WHERE "${pk}" = ANY($1)`,
      [keys],
    );
    return result.rowCount ?? 0;
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM "${this.table}"`);
  }

  async find(where: QueryNode, options: FindOptions = {}): Promise<Array<{ key: string | number; value: string; columns: Record<string, unknown> }>> {
    validateQueryColumns(where, this.schema);
    const dialect = new PostgresDialect("value");
    const compiled = compileWhere(where, dialect);
    const params: unknown[] = [...compiled.params];
    const nowIdx = params.push(Date.now());

    let sql = `SELECT * FROM "${this.table}" WHERE ("expires_at" IS NULL OR "expires_at" > $${nowIdx}) AND (${compiled.sql})`;
    if (options.sort && options.sort.length > 0) {
      sql += ` ORDER BY ${compileOrderBy(options.sort, dialect)}`;
    }
    if (options.limit !== undefined) sql += ` LIMIT $${params.push(options.limit)}`;
    if (options.offset !== undefined) sql += ` OFFSET $${params.push(options.offset)}`;

    const result = await this.pool.query<Record<string, unknown>>(sql, params);
    const pk = this.pkName;
    return result.rows.map((row) => ({
      key: this.parsePk(row[pk]),
      value: row.value as string,
      columns: this.parseColumns(row),
    }));
  }

  async addKey(name: string, definition: KeyDefinition): Promise<void> {
    const evolved = evolveSchemaAddKey(this.schema, name, definition);
    if (schemasEqual(this.schema, evolved)) return;

    const colSql = `"${name}" ${pgType(definition.type)}${definition.nullable === false ? " NOT NULL" : ""}${definition.default !== undefined ? ` DEFAULT ${pgDefault(definition.default)}` : ""}`;
    await this.pool.query(`ALTER TABLE "${this.table}" ADD COLUMN IF NOT EXISTS ${colSql}`);

    if (definition.index) {
      const idxOpts = typeof definition.index === "object" ? definition.index : {};
      const idxName = idxOpts.name ?? `${this.table}_${name}_idx`;
      await this.pool.query(`CREATE ${idxOpts.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${idxName}" ON "${this.table}" ("${name}")`);
    }

    this.schema = evolved as unknown as TableSchema<Columns>;
    await this.pool.query(
      "UPDATE kvdb_schema_registry SET schema_json = $1 WHERE logical_name = $2",
      [JSON.stringify(this.schema), this.logicalName],
    );
  }

  async addIndex(definition: TableIndexDefinition | MultiKeyIndexDefinition): Promise<void> {
    const evolved = evolveSchemaAddIndex(this.schema, definition);
    if (schemasEqual(this.schema, evolved)) return;

    const cols = definition.keys ?? definition.columns ?? [];
    const idxName = definition.name ?? `${this.table}_${cols.join("_")}_idx`;
    await this.pool.query(
      `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${idxName}" ON "${this.table}" (${cols.map((c) => `"${c}"`).join(", ")})`,
    );

    this.schema = evolved as unknown as TableSchema<Columns>;
    await this.pool.query(
      "UPDATE kvdb_schema_registry SET schema_json = $1 WHERE logical_name = $2",
      [JSON.stringify(this.schema), this.logicalName],
    );
  }


  private parsePk(val: unknown): string | number {
    const pkType = this.schema.primaryKey?.type ?? "string";
    return pkType === "integer" ? Number(val) : String(val);
  }

  private parseColumns(row: Record<string, unknown>): Record<string, unknown> {
    const columns: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(this.secondaryKeys)) {
      const raw = row[name];
      if (raw === null || raw === undefined) {
        columns[name] = null;
      } else if (definition.type === "integer") {
        columns[name] = Number(raw);
      } else if (definition.type === "number") {
        columns[name] = Number(raw);
      } else if (definition.type === "boolean") {
        columns[name] = Boolean(raw);
      } else if (definition.type === "json" && typeof raw === "string") {
        try {
          columns[name] = JSON.parse(raw);
        } catch {
          columns[name] = raw;
        }
      } else {
        columns[name] = raw;
      }
    }
    return columns;
  }
}

function schemaTableName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, "_");
  return `kvdb_schema_${safe}_${simpleHash(name)}`;
}

function simpleHash(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function pgType(type: string): string {
  switch (type) {
    case "integer": return "BIGINT";
    case "number": return "DOUBLE PRECISION";
    case "boolean": return "BOOLEAN";
    case "json": return "JSONB";
    case "string":
    default:
      return "TEXT";
  }
}

function pgDefault(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value === null) return "NULL";
  return String(value);
}

function validateQueryColumns(node: QueryNode, schema: TableSchema): void {
  const norm = normalizeTableSchema(schema);
  validateQueryColumnsInner(node, norm);
}

function validateQueryColumnsInner(node: QueryNode, schema: NormalizedSchema): void {
  if (node.kind === "cmp" || node.kind === "exists" || node.kind === "elemMatch") {
    if (node.path.sourceKind === "column") {
      const col = node.path.source;
      if (col !== schema.primaryKey.name && !(col in schema.keys)) {
        throw new KvdbConfigError(`Unknown schema column: ${col}`);
      }
    }
    if (node.kind === "elemMatch") validateQueryColumnsInner(node.child, schema);
    return;
  }
  if (node.kind === "and" || node.kind === "or" || node.kind === "nor") {
    for (const child of node.children) validateQueryColumnsInner(child, schema);
  }
  if (node.kind === "not") validateQueryColumnsInner(node.child, schema);
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}

