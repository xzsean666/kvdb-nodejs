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
import { validateTableSchema, schemasEqual } from "../../core/table-schema.js";
import type { TableSchema } from "../../core/table-schema.js";
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
    schema?: TableSchema<Columns>,
  ): SchemaTableDriver<unknown, Columns> | undefined {
    this.database.exec("CREATE TABLE IF NOT EXISTS kvdb_schema_registry (logical_name TEXT PRIMARY KEY, schema_json TEXT NOT NULL)");
    const existing = this.database.prepare("SELECT schema_json FROM kvdb_schema_registry WHERE logical_name = ?").get(name) as { schema_json: string } | undefined;
    if (existing && schema && !schemasEqual(JSON.parse(existing.schema_json) as TableSchema, schema)) {
      throw new KvdbConfigError(`Schema conflict for table ${name}`);
    }
    const resolved = (schema ?? (existing ? JSON.parse(existing.schema_json) : undefined)) as TableSchema<Columns> | undefined;
    if (!resolved) return undefined;
    validateTableSchema(resolved);
    const physical = schemaTableName(name);
    if (!existing) {
      const definitions = Object.entries(resolved.columns).map(([column, definition]) => `${column} ${sqliteType(definition.type)}${definition.nullable === false ? " NOT NULL" : ""}${definition.default !== undefined ? ` DEFAULT ${sqlDefault(definition.default)}` : ""}`).join(",\n");
      this.database.exec(`CREATE TABLE IF NOT EXISTS ${physical} (key TEXT PRIMARY KEY, ${definitions}${definitions ? "," : ""} value TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      this.database.prepare("INSERT INTO kvdb_schema_registry (logical_name, schema_json) VALUES (?, ?)").run(name, JSON.stringify(resolved));
      for (const [column, definition] of Object.entries(resolved.columns)) if (definition.index) this.createColumnIndex(physical, column, typeof definition.index === "object" ? definition.index : {});
      for (const index of resolved.indexes ?? []) this.createCompositeIndex(physical, index);
    }
    return new SqliteSchemaTable(this.database, physical, resolved);
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
  constructor(private readonly database: BetterSqlite3.Database, private readonly table: string, readonly schema: TableSchema<Columns>) {}
  setRecord(key: string, value: string, columns: Record<string, unknown>, ttlMs?: number): void {
    const names = Object.keys(this.schema.columns);
    const now = Date.now();
    const fields = ["key", ...names, "value", "expires_at", "created_at", "updated_at"];
    const placeholders = fields.map((field) => `@${field}`).join(",");
    const params: Record<string, unknown> = { key, value, expires_at: expiresAtFromTtl(ttlMs, now) ?? null, created_at: now, updated_at: now };
    for (const name of names) {
      const value = columns[name];
      const type = this.schema.columns[name]!.type;
      params[name] = value === undefined ? null : type === "json" ? JSON.stringify(value) : type === "boolean" ? (value ? 1 : 0) : value;
    }
    this.database.prepare(`INSERT INTO ${this.table} (${fields.join(",")}) VALUES (${placeholders}) ON CONFLICT(key) DO UPDATE SET ${[...names, "value", "expires_at", "updated_at"].map((field) => `${field}=excluded.${field}`).join(",")}`).run(params);
  }
  getRecord(key: string): { key: string; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined {
    const row = this.database.prepare(`SELECT * FROM ${this.table} WHERE key = ?`).get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const expiry = row.expires_at as number | null;
    if (expiry !== null && expiry <= Date.now()) { this.delete(key); return undefined; }
    const columns: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(this.schema.columns)) {
      const raw = row[name];
      columns[name] = raw === null ? null : definition.type === "json" && typeof raw === "string" ? JSON.parse(raw) : definition.type === "boolean" ? Boolean(raw) : raw;
    }
    return { key: row.key as string, value: row.value as string, columns, expiresAt: expiry ?? undefined };
  }
  delete(key: string): boolean { return this.database.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run(key).changes > 0; }
  clear(): void { this.database.exec(`DELETE FROM ${this.table}`); }
  find(where: QueryNode, options: FindOptions = {}): Array<{ key: string; value: string; columns: Record<string, unknown> }> {
    validateQueryColumns(where, this.schema);
    const dialect = new SqliteDialect("value");
    const compiled = compileWhere(where, dialect);
    const params: unknown[] = [Date.now(), ...compiled.params];
    let sql = `SELECT * FROM ${this.table} WHERE (expires_at IS NULL OR expires_at > ?) AND (${compiled.sql})`;
    if (options.sort?.length) sql += ` ORDER BY ${compileOrderBy(options.sort, dialect)}`;
    if (options.limit !== undefined) { sql += " LIMIT ?"; params.push(options.limit); }
    if (options.offset !== undefined) { sql += options.limit === undefined ? " LIMIT -1 OFFSET ?" : " OFFSET ?"; params.push(options.offset); }
    const rows = this.database.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({ key: row.key as string, value: row.value as string, columns: Object.fromEntries(Object.keys(this.schema.columns).map((name) => [name, row[name]])) }));
  }
}

function validateQueryColumns(node: QueryNode, schema: TableSchema): void {
  if (node.kind === "cmp" || node.kind === "exists" || node.kind === "elemMatch") {
    if (node.path.sourceKind === "column" && !(node.path.source in schema.columns)) throw new KvdbConfigError(`Unknown schema column: ${node.path.source}`);
    if (node.kind === "elemMatch") validateQueryColumns(node.child, schema);
    return;
  }
  if (node.kind === "and" || node.kind === "or" || node.kind === "nor") for (const child of node.children) validateQueryColumns(child, schema);
  if (node.kind === "not") validateQueryColumns(node.child, schema);
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
