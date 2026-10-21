// MySQL / MariaDB driver implementation based on mysql2/promise.
//
// Provides robust relational KV storage, ACID transactions with row-level locks (SELECT ... FOR UPDATE),
// dynamic Schema Table support, and AST-level JSON querying.

import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
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
import { MysqlDialect } from "./dialect.js";
import { evaluateQuery, sortDocuments } from "../../query/evaluator.js";
import { deserialize, serialize } from "../../core/serializer.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";
import type {
  TableSchema,
  MultiKeySchema,
  KeyDefinition,
  TableIndexDefinition,
  MultiKeyIndexDefinition,
} from "../../core/table-schema.js";
import {
  validateTableSchema,
  validateMultiKeySchema,
  normalizeTableSchema,
  schemasEqual,
  evolveSchemaAddKey,
  evolveSchemaAddIndex,
} from "../../core/table-schema.js";
import { expiresAtFromTtl } from "../../core/expiry.js";
import { compareKeysDeterministic } from "../../core/batcher.js";

export interface MysqlPoolOptions {
  connectionLimit?: number;
  queueLimit?: number;
  connectTimeout?: number;
  ssl?: unknown;
}

export interface MysqlDriverOptions {
  /** MySQL connection URL (e.g., "mysql://root:password@127.0.0.1:3306/database"). */
  url?: string;
  /** Existing mysql2 Pool instance. */
  pool?: Pool;
  /** Connection pool tuning options. */
  poolOptions?: MysqlPoolOptions;
  /** Primary physical KV table name. Default "kvdb_kv". */
  table?: string;
  /** Pre-created value-path indexes (if any). */
  indexes?: string[];
}

let mysqlModule: any;

async function loadMysql(): Promise<any> {
  if (!mysqlModule) {
    try {
      mysqlModule = await import("mysql2/promise");
    } catch {
      throw new KvdbConfigError(
        "The 'mysql2' package is required to use the MySQL driver. Install it with: pnpm add mysql2",
      );
    }
  }
  return mysqlModule;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class MysqlDriverFactory implements DriverFactory {
  readonly provider: ProviderName = "mysql";
  readonly capabilities: DriverCapabilities = {
    nativeTtl: false,
    jsonQuery: "mysql-json",
    managesOwnPool: true,
    supportsTransactions: true,
    supportsPrefixScan: true,
  };

  constructor(private readonly options: MysqlDriverOptions) {
    if (options.table !== undefined && !IDENTIFIER.test(options.table)) {
      throw new KvdbConfigError(`Invalid table name: ${JSON.stringify(options.table)}`);
    }
  }

  async connect(): Promise<Driver> {
    const table = this.options.table ?? "kvdb_kv";
    let pool = this.options.pool;
    let ownsPool = false;

    if (!pool) {
      if (!this.options.url) {
        throw new KvdbConfigError("The MySQL driver requires a connection `url`.");
      }
      const mysql = await loadMysql();
      pool = mysql.createPool({
        uri: this.options.url,
        waitForConnections: true,
        connectionLimit: this.options.poolOptions?.connectionLimit ?? 10,
        queueLimit: this.options.poolOptions?.queueLimit ?? 0,
        connectTimeout: this.options.poolOptions?.connectTimeout,
        ssl: this.options.poolOptions?.ssl,
        charset: "utf8mb4",
      }) as Pool;
      ownsPool = true;
    }

    try {
      const activePool: Pool = pool;
      await activePool.query(`
        CREATE TABLE IF NOT EXISTS \`${table}\` (
          \`key\` VARCHAR(512) PRIMARY KEY,
          \`value\` LONGTEXT NOT NULL,
          \`expires_at\` BIGINT NULL,
          \`created_at\` BIGINT NOT NULL,
          \`updated_at\` BIGINT NOT NULL,
          INDEX \`idx_${table}_expires\` (\`expires_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      return new MysqlDriver(activePool, table, ownsPool);
    } catch (err) {
      if (ownsPool && pool) {
        await pool.end().catch(() => {});
      }
      throw err;
    }
  }
}

export class MysqlDriver implements Driver {
  readonly provider: ProviderName = "mysql";
  readonly capabilities: DriverCapabilities = {
    nativeTtl: false,
    jsonQuery: "mysql-json",
    managesOwnPool: true,
    supportsTransactions: true,
    supportsPrefixScan: true,
  };
  private readonly dialect = new MysqlDialect("value");

  constructor(
    private readonly pool: Pool,
    readonly table: string,
    private readonly ownsPool: boolean = false,
  ) {}

  async get(key: string): Promise<RawEntry | undefined> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT \`value\`, \`expires_at\` FROM \`${this.table}\` WHERE \`key\` = ?`,
      [key],
    );
    const row = rows[0];
    if (!row) return undefined;
    const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      return undefined;
    }
    return {
      value: row.value,
      expiresAt,
    };
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const now = Date.now();
    const expiresAt = expiresAtFromTtl(ttlMs, now);
    if (ttlMs !== undefined && ttlMs <= 0) {
      await this.delete(key);
      return;
    }

    await this.pool.query(
      `INSERT INTO \`${this.table}\` (\`key\`, \`value\`, \`expires_at\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         \`value\` = VALUES(\`value\`),
         \`expires_at\` = VALUES(\`expires_at\`),
         \`updated_at\` = VALUES(\`updated_at\`)`,
      [key, value, expiresAt ?? null, now, now],
    );
  }

  async delete(key: string): Promise<boolean> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM \`${this.table}\` WHERE \`key\` = ?`,
      [key],
    );
    return result.affectedRows > 0;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM \`${this.table}\``);
  }

  async getMany(keys: string[]): Promise<(RawEntry | undefined)[]> {
    if (keys.length === 0) return [];
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT \`key\`, \`value\`, \`expires_at\` FROM \`${this.table}\` WHERE \`key\` IN (?)`,
      [keys],
    );
    const now = Date.now();
    const byKey = new Map<string, RawEntry>();
    for (const row of rows) {
      const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
      if (expiresAt !== undefined && expiresAt <= now) continue;
      byKey.set(row.key, { value: row.value, expiresAt });
    }
    return keys.map((k) => byKey.get(k));
  }

  async setMany(entries: KVEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = Date.now();
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const entry of entries) {
        const expiresAt = expiresAtFromTtl(entry.ttlMs, now);
        if (entry.ttlMs !== undefined && entry.ttlMs <= 0) {
          await conn.query(`DELETE FROM \`${this.table}\` WHERE \`key\` = ?`, [entry.key]);
        } else {
          await conn.query(
            `INSERT INTO \`${this.table}\` (\`key\`, \`value\`, \`expires_at\`, \`created_at\`, \`updated_at\`)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               \`value\` = VALUES(\`value\`),
               \`expires_at\` = VALUES(\`expires_at\`),
               \`updated_at\` = VALUES(\`updated_at\`)`,
            [entry.key, entry.value, expiresAt ?? null, now, now],
          );
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM \`${this.table}\` WHERE \`key\` IN (?)`,
      [keys],
    );
    return result.affectedRows;
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    let sql = `SELECT \`key\`, \`value\`, \`expires_at\` FROM \`${this.table}\``;
    const params: unknown[] = [];
    if (prefix !== undefined) {
      sql += ` WHERE \`key\` LIKE ?`;
      params.push(`${escapeLike(prefix)}%`);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    const now = Date.now();
    for (const row of rows) {
      const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
      if (expiresAt !== undefined && expiresAt <= now) continue;
      yield [row.key, { value: row.value, expiresAt }];
    }
  }

  async getByPrefix(prefix: string): Promise<KVEntry[]> {
    const now = Date.now();
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT \`key\`, \`value\` FROM \`${this.table}\`
       WHERE \`key\` LIKE ? AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)`,
      [`${escapeLike(prefix)}%`, now],
    );
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM \`${this.table}\` WHERE \`key\` LIKE ?`,
      [`${escapeLike(prefix)}%`],
    );
    return result.affectedRows;
  }

  async find(
    where: QueryNode,
    options: FindOptions = {},
    keyPrefix?: string,
  ): Promise<KVEntry[]> {
    const compiled = compileWhere(where, this.dialect);
    const clauses = [`(\`expires_at\` IS NULL OR \`expires_at\` > ?)`, `(${compiled.sql})`];
    const params: unknown[] = [Date.now(), ...compiled.params];

    if (keyPrefix) {
      clauses.push(`\`key\` LIKE ?`);
      params.push(`${escapeLike(keyPrefix)}%`);
    }

    let sql = `SELECT \`key\`, \`value\` FROM \`${this.table}\` WHERE ${clauses.join(" AND ")}`;
    if (options.sort && options.sort.length > 0) {
      sql += ` ORDER BY ${compileOrderBy(options.sort, this.dialect)}`;
    }
    if (options.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      if (options.limit === undefined) {
        sql += ` LIMIT 18446744073709551615 OFFSET ?`;
      } else {
        sql += ` OFFSET ?`;
      }
      params.push(options.offset);
    }

    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }

  async update(key: string, mutate: UpdateMutator): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = Date.now();
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT \`value\`, \`expires_at\` FROM \`${this.table}\` WHERE \`key\` = ? FOR UPDATE`,
        [key],
      );

      let current: RawEntry | undefined;
      const row = rows[0];
      if (row) {
        const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
        if (expiresAt === undefined || expiresAt > now) {
          current = { value: row.value, expiresAt };
        }
      }

      const next = mutate(current);
      const nextExpiresAt = expiresAtFromTtl(next.ttlMs, now);

      await conn.query(
        `INSERT INTO \`${this.table}\` (\`key\`, \`value\`, \`expires_at\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           \`value\` = VALUES(\`value\`),
           \`expires_at\` = VALUES(\`expires_at\`),
           \`updated_at\` = VALUES(\`updated_at\`)`,
        [key, next.value, nextExpiresAt ?? null, now, now],
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async ensureIndex(_jsonPath: string): Promise<void> {
    // Expression indexing fallback handled via in-memory query evaluator.
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM \`${this.table}\` WHERE \`expires_at\` IS NOT NULL AND \`expires_at\` <= ?`,
      [now],
    );
    return result.affectedRows;
  }

  async openSchemaTable<Columns extends Record<string, unknown>>(
    name: string,
    schema?: TableSchema<Columns> | MultiKeySchema<Columns>,
  ): Promise<SchemaTableDriver<unknown, Columns> | undefined> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS \`kvdb_schema_registry\` (
        \`logical_name\` VARCHAR(128) PRIMARY KEY,
        \`schema_json\` LONGTEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [existingRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT \`schema_json\` FROM \`kvdb_schema_registry\` WHERE \`logical_name\` = ?`,
      [name],
    );
    const existing = existingRows[0];
    const existingSchemaJson = existing ? (existing as Record<string, any>).schema_json : undefined;
    if (existingSchemaJson && schema && !schemasEqual(JSON.parse(existingSchemaJson) as TableSchema, schema)) {
      throw new KvdbConfigError(`Schema conflict for table ${name}`);
    }

    const resolved = (schema ?? (existingSchemaJson ? JSON.parse(existingSchemaJson) : undefined)) as TableSchema<Columns> | undefined;
    if (!resolved) return undefined;
    validateTableSchema(resolved);
    const norm = normalizeTableSchema(resolved);
    const physical = schemaTableName(name);

    if (!existing) {
      const pkSql = `\`${norm.primaryKey.name}\` ${norm.primaryKey.type === "integer" ? "BIGINT PRIMARY KEY" : "VARCHAR(255) PRIMARY KEY"}`;
      const definitions = Object.entries(norm.keys)
        .map(([column, def]) => `\`${column}\` ${mysqlType(def.type)}${def.nullable === false ? " NOT NULL" : ""}${def.default !== undefined ? ` DEFAULT ${mysqlDefault(def.default)}` : ""}`)
        .join(",\n");

      const tsDefs = norm.timestamps !== false ? ',\n          `created_at` BIGINT NOT NULL,\n          `updated_at` BIGINT NOT NULL' : '';
      const expIdx = safeIndexName(`idx_${physical}_expires`);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS \`${physical}\` (
          ${pkSql},
          ${definitions}${definitions ? "," : ""}
          \`value\` LONGTEXT NOT NULL,
          \`expires_at\` BIGINT NULL${tsDefs},
          INDEX \`${expIdx}\` (\`expires_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await this.pool.query(
        `INSERT IGNORE INTO \`kvdb_schema_registry\` (\`logical_name\`, \`schema_json\`) VALUES (?, ?)`,
        [name, JSON.stringify(resolved)],
      );

      for (const [column, def] of Object.entries(norm.keys)) {
        if (def.index) {
          const idxOpts = typeof def.index === "object" ? def.index : {};
          const rawIdxName = idxOpts.name ?? `${physical}_${column}_idx`;
          const idxName = safeIndexName(rawIdxName);
          await this.createIndexIfNotExists(physical, idxName, [column], Boolean(idxOpts.unique));
        }
      }

      for (const index of norm.indexes) {
        const rawIdxName = index.name ?? `${physical}_${index.keys.join("_")}_idx`;
        const idxName = safeIndexName(rawIdxName);
        await this.createIndexIfNotExists(physical, idxName, index.keys, Boolean(index.unique));
      }
    }

    return new MysqlSchemaTable(this.pool, physical, name, resolved);
  }

  async dropSchemaTable(name: string): Promise<void> {
    const physical = schemaTableName(name);
    await this.pool.query(`DROP TABLE IF EXISTS \`${physical}\``);
    try {
      await this.pool.query(`DELETE FROM \`kvdb_schema_registry\` WHERE \`logical_name\` = ?`, [name]);
    } catch {
      // Ignore
    }
  }

  raw(): Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  private async createIndexIfNotExists(
    table: string,
    idxName: string,
    columns: string[],
    unique: boolean,
  ): Promise<void> {
    try {
      const colList = columns.map((c) => `\`${c}\``).join(", ");
      await this.pool.query(
        `CREATE ${unique ? "UNIQUE " : ""}INDEX \`${idxName}\` ON \`${table}\` (${colList})`,
      );
    } catch (err: any) {
      // Ignore if index already exists
      if (!String(err?.message).includes("Duplicate key name")) {
        throw err;
      }
    }
  }
}

class MysqlSchemaTable<Columns extends Record<string, unknown>>
  implements SchemaTableDriver<unknown, Columns>
{
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

  private get hasTimestamps(): boolean {
    return this.schema.timestamps !== false;
  }

  async setRecord(
    key: string | number,
    value: string,
    columns: Record<string, unknown>,
    ttlMs?: number,
  ): Promise<void> {
    const pk = this.pkName;
    const now = Date.now();
    const cols = Object.keys(this.secondaryKeys);
    const colNames = [pk, ...cols, "value", "expires_at"];
    if (this.hasTimestamps) colNames.push("created_at", "updated_at");
    const placeholders = colNames.map(() => "?").join(", ");

    const values = [
      key,
      ...cols.map((name) => this.serializeColumnValue(name, columns[name])),
      value,
      expiresAtFromTtl(ttlMs, now) ?? null,
    ];
    if (this.hasTimestamps) {
      values.push(now, now);
    }

    const updatesList = [
      ...cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`),
      `\`value\` = VALUES(\`value\`)`,
      `\`expires_at\` = VALUES(\`expires_at\`)`,
    ];
    if (this.hasTimestamps) updatesList.push(`\`updated_at\` = VALUES(\`updated_at\`)`);
    const updates = updatesList.join(", ");

    await this.pool.query(
      `INSERT INTO \`${this.table}\` (${colNames.map((c) => `\`${c}\``).join(", ")})
       VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      values,
    );
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
    const sortedItems = items.length > 1
      ? items.slice().sort((a, b) => compareKeysDeterministic(a.key, b.key))
      : items;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const pk = this.pkName;
      const now = Date.now();
      const cols = Object.keys(this.secondaryKeys);
      const colNames = [pk, ...cols, "value", "expires_at"];
      if (this.hasTimestamps) colNames.push("created_at", "updated_at");
      const tuplePlaceholders = `(${colNames.map(() => "?").join(", ")})`;
      const updatesList = [
        ...cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`),
        `\`value\` = VALUES(\`value\`)`,
        `\`expires_at\` = VALUES(\`expires_at\`)`,
      ];
      if (this.hasTimestamps) updatesList.push(`\`updated_at\` = VALUES(\`updated_at\`)`);
      const updates = updatesList.join(", ");

      const CHUNK_SIZE = 200;
      for (let i = 0; i < sortedItems.length; i += CHUNK_SIZE) {
        const chunk = sortedItems.slice(i, i + CHUNK_SIZE);
        const allParams: unknown[] = [];
        const tuples: string[] = [];

        for (const item of chunk) {
          tuples.push(tuplePlaceholders);
          allParams.push(
            item.key,
            ...cols.map((name) => this.serializeColumnValue(name, item.columns[name])),
            item.value,
            expiresAtFromTtl(item.ttlMs, now) ?? null,
          );
          if (this.hasTimestamps) {
            allParams.push(now, now);
          }
        }

        const sql = `INSERT INTO \`${this.table}\` (${colNames.map((c) => `\`${c}\``).join(", ")})
         VALUES ${tuples.join(", ")}
         ON DUPLICATE KEY UPDATE ${updates}`;

        await conn.query(sql, allParams);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async getRecord(
    key: string | number,
  ): Promise<
    | {
        key: string | number;
        value: string;
        columns: Record<string, unknown>;
        expiresAt?: number;
      }
    | undefined
  > {
    const pk = this.pkName;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM \`${this.table}\` WHERE \`${pk}\` = ?`,
      [key],
    );
    const row = rows[0];
    if (!row) return undefined;
    const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
    if (expiresAt !== undefined && expiresAt <= Date.now()) return undefined;

    return {
      key: this.parsePk(row[pk]),
      value: row.value,
      columns: this.parseColumns(row as Record<string, unknown>),
      expiresAt,
    };
  }

  async getRecordByKey(
    keyName: string,
    keyValue: unknown,
  ): Promise<
    | {
        key: string | number;
        value: string;
        columns: Record<string, unknown>;
        expiresAt?: number;
      }
    | undefined
  > {
    const pk = this.pkName;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM \`${this.table}\` WHERE \`${keyName}\` = ? LIMIT 1`,
      [keyValue],
    );
    const row = rows[0];
    if (!row) return undefined;
    const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
    if (expiresAt !== undefined && expiresAt <= Date.now()) return undefined;

    return {
      key: this.parsePk(row[pk]),
      value: row.value,
      columns: this.parseColumns(row as Record<string, unknown>),
      expiresAt,
    };
  }

  async delete(key: string | number): Promise<boolean> {
    const pk = this.pkName;
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM \`${this.table}\` WHERE \`${pk}\` = ?`,
      [key],
    );
    return result.affectedRows > 0;
  }

  async deleteRecords(keys: (string | number)[]): Promise<number> {
    if (keys.length === 0) return 0;
    const pk = this.pkName;
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM \`${this.table}\` WHERE \`${pk}\` IN (?)`,
      [keys],
    );
    return result.affectedRows;
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM \`${this.table}\``);
  }

  async find(
    where: QueryNode,
    options: FindOptions = {},
  ): Promise<
    Array<{
      key: string | number;
      value: string;
      columns: Record<string, unknown>;
    }>
  > {
    const dialect = new MysqlDialect("value");
    const compiled = compileWhere(where, dialect);
    const params: unknown[] = [Date.now(), ...compiled.params];

    let sql = `SELECT * FROM \`${this.table}\` WHERE (\`expires_at\` IS NULL OR \`expires_at\` > ?) AND (${compiled.sql})`;
    if (options.sort && options.sort.length > 0) {
      sql += ` ORDER BY ${compileOrderBy(options.sort, dialect)}`;
    }
    if (options.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      if (options.limit === undefined) {
        sql += ` LIMIT 18446744073709551615 OFFSET ?`;
      } else {
        sql += ` OFFSET ?`;
      }
      params.push(options.offset);
    }

    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    const pk = this.pkName;
    return rows.map((row) => ({
      key: this.parsePk(row[pk]),
      value: row.value as string,
      columns: this.parseColumns(row as Record<string, unknown>),
    }));
  }

  async updateRecord(
    key: string | number,
    mutate: (
      current:
        | {
            key: string | number;
            value: string;
            columns: Record<string, unknown>;
            expiresAt?: number;
          }
        | undefined,
    ) => UpdateResult,
  ): Promise<void> {
    const pk = this.pkName;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = Date.now();
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT * FROM \`${this.table}\` WHERE \`${pk}\` = ? FOR UPDATE`,
        [key],
      );

      let current:
        | {
            key: string | number;
            value: string;
            columns: Record<string, unknown>;
            expiresAt?: number;
          }
        | undefined;

      const row = rows[0];
      if (row) {
        const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
        if (expiresAt === undefined || expiresAt > now) {
          current = {
            key: this.parsePk(row[pk]),
            value: row.value as string,
            columns: this.parseColumns(row as Record<string, unknown>),
            expiresAt,
          };
        }
      }

      const next = mutate(current);
      const nextExpiresAt = expiresAtFromTtl(next.ttlMs, now);
      const cols = next.columns !== undefined
        ? { ...(current ? current.columns : {}), ...next.columns }
        : (current ? current.columns : {});

      const keyCols = Object.keys(this.secondaryKeys);
      const colNames = [pk, ...keyCols, "value", "expires_at"];
      if (this.hasTimestamps) colNames.push("created_at", "updated_at");
      const placeholders = colNames.map(() => "?").join(", ");

      const values = [
        key,
        ...keyCols.map((name) => this.serializeColumnValue(name, cols[name])),
        next.value,
        nextExpiresAt ?? null,
      ];
      if (this.hasTimestamps) {
        values.push(now, now);
      }

      const updatesList = [
        ...keyCols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`),
        `\`value\` = VALUES(\`value\`)`,
        `\`expires_at\` = VALUES(\`expires_at\`)`,
      ];
      if (this.hasTimestamps) updatesList.push(`\`updated_at\` = VALUES(\`updated_at\`)`);
      const updates = updatesList.join(", ");

      await conn.query(
        `INSERT INTO \`${this.table}\` (${colNames.map((c) => `\`${c}\``).join(", ")})
         VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updates}`,
        values,
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async addKey(name: string, definition: KeyDefinition): Promise<void> {
    const evolved = evolveSchemaAddKey(this.schema, name, definition);
    if (schemasEqual(this.schema, evolved)) return;

    const colSql = `\`${name}\` ${mysqlType(definition.type)}${definition.nullable === false ? " NOT NULL" : ""}${definition.default !== undefined ? ` DEFAULT ${mysqlDefault(definition.default)}` : ""}`;
    await this.pool.query(`ALTER TABLE \`${this.table}\` ADD COLUMN ${colSql}`);

    if (definition.index) {
      const idxOpts = typeof definition.index === "object" ? definition.index : {};
      const idxName = idxOpts.name ?? `${this.table}_${name}_idx`;
      await this.pool.query(
        `CREATE ${idxOpts.unique ? "UNIQUE " : ""}INDEX \`${idxName}\` ON \`${this.table}\` (\`${name}\`)`,
      );
    }

    this.schema = evolved as unknown as TableSchema<Columns>;
    await this.pool.query(
      `UPDATE \`kvdb_schema_registry\` SET \`schema_json\` = ? WHERE \`logical_name\` = ?`,
      [JSON.stringify(this.schema), this.logicalName],
    );
  }

  async addIndex(definition: TableIndexDefinition | MultiKeyIndexDefinition): Promise<void> {
    const evolved = evolveSchemaAddIndex(this.schema, definition);
    if (schemasEqual(this.schema, evolved)) return;

    const cols = definition.keys ?? definition.columns ?? [];
    const idxName = definition.name ?? `${this.table}_${cols.join("_")}_idx`;
    await this.pool.query(
      `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX \`${idxName}\` ON \`${this.table}\` (${cols.map((c) => `\`${c}\``).join(", ")})`,
    );

    this.schema = evolved as unknown as TableSchema<Columns>;
    await this.pool.query(
      `UPDATE \`kvdb_schema_registry\` SET \`schema_json\` = ? WHERE \`logical_name\` = ?`,
      [JSON.stringify(this.schema), this.logicalName],
    );
  }

  private parsePk(val: unknown): string | number {
    const pkType = this.schema.primaryKey?.type ?? "string";
    return pkType === "integer" ? Number(val) : String(val);
  }

  private serializeColumnValue(name: string, val: unknown): unknown {
    const def = this.secondaryKeys[name];
    if (!def) return val ?? null;
    const finalVal = val === undefined ? (def.default ?? null) : val;
    if (finalVal === null) return null;
    if (def.type === "json" && typeof finalVal !== "string") {
      return JSON.stringify(finalVal);
    }
    if (def.type === "boolean") {
      return finalVal ? 1 : 0;
    }
    return finalVal;
  }

  private parseColumns(row: Record<string, unknown>): Record<string, unknown> {
    const columns: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(this.secondaryKeys)) {
      const raw = row[name];
      if (raw === undefined || raw === null) {
        columns[name] = raw === null ? null : (definition.default ?? null);
      } else if (definition.type === "integer" || definition.type === "number") {
        columns[name] = Number(raw);
      } else if (definition.type === "boolean") {
        columns[name] = Boolean(raw);
      } else if (definition.type === "json") {
        if (typeof raw === "string") {
          try {
            columns[name] = JSON.parse(raw);
          } catch {
            columns[name] = raw;
          }
        } else {
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
  const hash = simpleHash(name);
  const safe = name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 36);
  return `kvdb_schema_${safe}_${hash}`;
}

function safeIndexName(raw: string): string {
  if (raw.length <= 64) return raw;
  const hash = simpleHash(raw);
  return `idx_${hash}_${raw.slice(0, 48)}`;
}

function simpleHash(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function mysqlType(type: string): string {
  switch (type) {
    case "integer":
      return "BIGINT";
    case "number":
      return "DOUBLE";
    case "boolean":
      return "TINYINT(1)";
    case "json":
      return "LONGTEXT";
    default:
      return "VARCHAR(255)";
  }
}

function mysqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value === null) return "NULL";
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return String(value);
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}
