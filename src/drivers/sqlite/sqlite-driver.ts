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
import { SqliteDialect } from "./dialect.js";
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


import type { SchemaTableDriver } from "../types.js";

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

  update(key: string, mutate: UpdateMutator): void {
    // BEGIN IMMEDIATE takes the write lock up front, so a concurrent updater on
    // another connection waits rather than reading a stale value (lost update).
    // better-sqlite3 transactions are synchronous, which is why mutate is sync.
    const run = this.database.transaction((k: string) => {
      const result = mutate(this.get(k));
      const now = Date.now();
      this.statements.upsert.run({
        key: k,
        value: result.value,
        expiresAt: expiresAtFromTtl(result.ttlMs, now) ?? null,
        now,
      });
    });
    run.immediate(key);
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

  openSchemaTable<Columns extends Record<string, unknown>>(
    name: string,
    schema?: TableSchema<Columns> | MultiKeySchema<Columns>,
  ): SchemaTableDriver<unknown, Columns> | undefined {

    this.database.exec("CREATE TABLE IF NOT EXISTS kvdb_schema_registry (logical_name TEXT PRIMARY KEY, schema_json TEXT NOT NULL)");
    const existing = this.database.prepare("SELECT schema_json FROM kvdb_schema_registry WHERE logical_name = ?").get(name) as { schema_json: string } | undefined;
    if (existing && schema && !schemasEqual(JSON.parse(existing.schema_json) as TableSchema, schema)) {
      throw new KvdbConfigError(`Schema conflict for table ${name}`);
    }
    const resolved = (schema ?? (existing ? JSON.parse(existing.schema_json) : undefined)) as TableSchema<Columns> | undefined;
    if (!resolved) return undefined;
    validateTableSchema(resolved);
    const norm = normalizeTableSchema(resolved);
    const physical = schemaTableName(name);
    if (!existing) {
      const pkSql = `${norm.primaryKey.name} ${norm.primaryKey.type === "integer" ? "INTEGER PRIMARY KEY" : "TEXT PRIMARY KEY"}`;
      const definitions = Object.entries(norm.keys).map(([column, definition]) => `${column} ${sqliteType(definition.type)}${definition.nullable === false ? " NOT NULL" : ""}${definition.default !== undefined ? ` DEFAULT ${sqlDefault(definition.default)}` : ""}`).join(",\n");
      this.database.exec(`CREATE TABLE IF NOT EXISTS ${physical} (${pkSql}, ${definitions}${definitions ? "," : ""} value TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      this.database.exec(`CREATE INDEX IF NOT EXISTS ${physical}_expires_at ON ${physical} (expires_at)`);
      this.database.prepare("INSERT INTO kvdb_schema_registry (logical_name, schema_json) VALUES (?, ?)").run(name, JSON.stringify(resolved));
      for (const [column, definition] of Object.entries(norm.keys)) if (definition.index) this.createColumnIndex(physical, column, typeof definition.index === "object" ? definition.index : {});
      for (const index of norm.indexes) this.createCompositeIndex(physical, index);
    }
    return new SqliteSchemaTable(this.database, physical, name, resolved);
  }

  private createColumnIndex(table: string, column: string, options: { name?: string; unique?: boolean }): void {
    const index = options.name ?? `${table}_${column}_idx`;
    this.database.exec(`CREATE ${options.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${index} ON ${table} (${column})`);
  }
  private createCompositeIndex(table: string, definition: { name?: string; columns: string[]; unique?: boolean }): void {
    const index = definition.name ?? `${table}_${definition.columns.join("_")}_idx`;
    this.database.exec(`CREATE ${definition.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${index} ON ${table} (${definition.columns.join(",")})`);
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

class SqliteSchemaTable<Columns extends Record<string, unknown>> implements SchemaTableDriver<unknown, Columns> {
  schema: TableSchema<Columns>;

  constructor(
    private readonly database: BetterSqlite3.Database,
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

  setRecord(key: string | number, value: string, columns: Record<string, unknown>, ttlMs?: number): void {
    const pk = this.pkName;
    const names = Object.keys(this.secondaryKeys);
    const now = Date.now();
    const fields = [pk, ...names, "value", "expires_at", "created_at", "updated_at"];
    const placeholders = fields.map((field) => `@${field}`).join(",");
    const params: Record<string, unknown> = {
      [pk]: key,
      value,
      expires_at: expiresAtFromTtl(ttlMs, now) ?? null,
      created_at: now,
      updated_at: now,
    };
    for (const name of names) {
      const def = this.secondaryKeys[name]!;
      const val = columns[name] !== undefined ? columns[name] : (def.default !== undefined ? def.default : null);
      if (val === null || val === undefined) {
        params[name] = null;
      } else if (def.type === "boolean") {
        params[name] = val ? 1 : 0;
      } else if (def.type === "json") {
        params[name] = JSON.stringify(val);
      } else {
        params[name] = val;
      }
    }
    const updateClauses = [...names, "value", "expires_at", "updated_at"].map((field) => `${field}=excluded.${field}`).join(",");
    this.database.prepare(
      `INSERT INTO ${this.table} (${fields.join(",")}) VALUES (${placeholders}) ON CONFLICT(${pk}) DO UPDATE SET ${updateClauses}`
    ).run(params);
  }

  getRecord(key: string | number): { key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined {
    const pk = this.pkName;
    const row = this.database.prepare(`SELECT * FROM ${this.table} WHERE ${pk} = ?`).get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const expiry = row.expires_at as number | null;
    if (expiry !== null && expiry <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    const columns: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(this.secondaryKeys)) {
      const raw = row[name];
      columns[name] = raw === null ? null
        : definition.type === "json" && typeof raw === "string" ? JSON.parse(raw)
        : definition.type === "boolean" ? Boolean(raw)
        : raw;
    }
    return {
      key: row[pk] as string | number,
      value: row.value as string,
      columns,
      expiresAt: expiry ?? undefined,
    };
  }

  getRecordByKey(keyName: string, keyValue: unknown): { key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined {
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
      : def.type === "boolean" ? (keyValue ? 1 : 0)
      : keyValue;

    const row = this.database.prepare(`SELECT * FROM ${this.table} WHERE ${keyName} = ?`).get(param) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const expiry = row.expires_at as number | null;
    if (expiry !== null && expiry <= Date.now()) {
      this.delete(row[pk] as string | number);
      return undefined;
    }
    const columns: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(this.secondaryKeys)) {
      const raw = row[name];
      columns[name] = raw === null ? null
        : definition.type === "json" && typeof raw === "string" ? JSON.parse(raw)
        : definition.type === "boolean" ? Boolean(raw)
        : raw;
    }
    return {
      key: row[pk] as string | number,
      value: row.value as string,
      columns,
      expiresAt: expiry ?? undefined,
    };
  }

  delete(key: string | number): boolean {
    const pk = this.pkName;
    return this.database.prepare(`DELETE FROM ${this.table} WHERE ${pk} = ?`).run(key).changes > 0;
  }

  clear(): void {
    this.database.exec(`DELETE FROM ${this.table}`);
  }

  find(where: QueryNode, options: FindOptions = {}): Array<{ key: string | number; value: string; columns: Record<string, unknown> }> {
    validateQueryColumns(where, this.schema);
    const dialect = new SqliteDialect("value");
    const compiled = compileWhere(where, dialect);
    const params: unknown[] = [Date.now(), ...compiled.params];
    let sql = `SELECT * FROM ${this.table} WHERE (expires_at IS NULL OR expires_at > ?) AND (${compiled.sql})`;
    if (options.sort?.length) sql += ` ORDER BY ${compileOrderBy(options.sort, dialect)}`;
    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      sql += options.limit === undefined ? " LIMIT -1 OFFSET ?" : " OFFSET ?";
      params.push(options.offset);
    }
    const rows = this.database.prepare(sql).all(...params) as Record<string, unknown>[];
    const pk = this.pkName;
    return rows.map((row) => {
      const columns: Record<string, unknown> = {};
      for (const [name, definition] of Object.entries(this.secondaryKeys)) {
        const raw = row[name];
        columns[name] = raw === null ? null
          : definition.type === "json" && typeof raw === "string" ? JSON.parse(raw)
          : definition.type === "boolean" ? Boolean(raw)
          : raw;
      }
      return {
        key: row[pk] as string | number,
        value: row.value as string,
        columns,
      };
    });
  }

  addKey(name: string, definition: KeyDefinition): void {
    const evolved = evolveSchemaAddKey(this.schema, name, definition);
    if (schemasEqual(this.schema, evolved)) return;

    const colSql = `${name} ${sqliteType(definition.type)}${definition.nullable === false ? " NOT NULL" : ""}${definition.default !== undefined ? ` DEFAULT ${sqlDefault(definition.default)}` : ""}`;
    this.database.exec(`ALTER TABLE ${this.table} ADD COLUMN ${colSql}`);

    if (definition.index) {
      const idxOpts = typeof definition.index === "object" ? definition.index : {};
      const idxName = idxOpts.name ?? `${this.table}_${name}_idx`;
      this.database.exec(`CREATE ${idxOpts.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${idxName} ON ${this.table} (${name})`);
    }

    this.schema = evolved as unknown as TableSchema<Columns>;
    this.database.prepare("UPDATE kvdb_schema_registry SET schema_json = ? WHERE logical_name = ?").run(
      JSON.stringify(this.schema),
      this.logicalName,
    );
  }

  addIndex(definition: TableIndexDefinition | MultiKeyIndexDefinition): void {
    const evolved = evolveSchemaAddIndex(this.schema, definition);
    if (schemasEqual(this.schema, evolved)) return;

    const cols = definition.keys ?? definition.columns ?? [];
    const idxName = definition.name ?? `${this.table}_${cols.join("_")}_idx`;
    this.database.exec(`CREATE ${definition.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${idxName} ON ${this.table} (${cols.join(",")})`);

    this.schema = evolved as unknown as TableSchema<Columns>;
    this.database.prepare("UPDATE kvdb_schema_registry SET schema_json = ? WHERE logical_name = ?").run(
      JSON.stringify(this.schema),
      this.logicalName,
    );
  }
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


function schemaTableName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, "_");
  return `kvdb_schema_${safe}_${simpleHash(name)}`;
}
function simpleHash(value: string): string { let hash = 0; for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash.toString(36); }
function sqliteType(type: string): string { return type === "number" ? "REAL" : type === "integer" || type === "boolean" ? "INTEGER" : "TEXT"; }
function sqlDefault(value: unknown): string { if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`; if (typeof value === "boolean") return value ? "1" : "0"; if (value === null) return "NULL"; return String(value); }

/** Escape LIKE wildcards so a user prefix is matched literally (ESCAPE '\'). */
function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}
