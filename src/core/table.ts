// Table / Namespace — the CRUD + Query facade users operate on (docs/SPEC.md §3-6).
//
// A Table owns no connection; it asks its parent KVDB for the (lazily connected)
// Driver on each call. It is the single place that:
//   - turns user keys into physical keys (core/key.ts),
//   - (de)serializes values (core/serializer.ts),
//   - parses user query documents into the AST (query/parser.ts),
//   - applies the optional point-read cache.
// Drivers see only physical keys and canonical JSON — never user-facing shapes.

import type { Driver, UpdateResult } from "../drivers/types.js";
import type { Cache } from "../cache/cache.js";
import type { RawEntry } from "../cache/types.js";
import type { JsonValue } from "../types/json.js";
import { serialize, deserialize } from "./serializer.js";
import { KvdbError } from "./errors.js";
import { toPhysicalKey, toUserKey, toPhysicalPrefix, namespacePrefix } from "./key.js";
import type { KeyScope } from "./key.js";
import { parseWhere, parseSchemaWhere, parseFindOptions } from "../query/parser.js";
import { collectFieldPaths } from "../query/paths.js";
import type { HookRuntime } from "../plugins/runtime.js";
import type { AutoIndexManager } from "./auto-index.js";
import type {
  TableSchema,
  MultiKeySchema,
  PhysicalRecord,
  KeyDefinition,
  TableIndexDefinition,
  MultiKeyIndexDefinition,
} from "./table-schema.js";
import { validateColumnValues } from "./table-schema.js";
import type { SchemaTableDriver } from "../drivers/types.js";


/** User-facing query document for `find` (parsed into the AST internally). */
export interface FindQuery {
  where?: Record<string, unknown>;
  /** Schema tables may explicitly target physical columns or value JSON. */
  columns?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  sort?: { path: string; direction?: "asc" | "desc" }[];
}

export interface SetOptions<Columns = Record<string, unknown>> {
  ttlMs?: number;
  columns?: Partial<Columns> | Record<string, unknown>;
  keys?: Partial<Columns> | Record<string, unknown>;
}

/**
 * The change applied by {@link Table.update}. Either a partial object that is
 * shallow-merged into the stored value, or a function that receives the current
 * value and returns the next one (for nested or computed edits).
 */
export type UpdatePatch<Value> = Partial<Value> | ((current: Value) => Value);

export interface TableDependencies {
  /** Resolve the lazily-connected driver. */
  getDriver: () => Promise<Driver>;
  scope: KeyScope;
  /** Optional point-read cache shared from the KVDB instance. */
  cache?: Cache;
  /** Hook runtime (no-op when no plugins are registered). */
  hooks: HookRuntime;
  /** Optional auto-index manager (opt-in via KVDBOptions.autoIndex). */
  autoIndex?: AutoIndexManager;
  schemaName?: string;
  schema?: TableSchema | MultiKeySchema;
}

export class Table<Value = JsonValue, Columns extends Record<string, unknown> = Record<string, unknown>> {
  constructor(private readonly deps: TableDependencies) {}

  private get namespace(): string {
    return this.deps.scope.namespace;
  }

  private cacheKey(key: string, isSchema: boolean): string {
    return isSchema
      ? `schema:${this.deps.schemaName ?? this.namespace}:${key}`
      : toPhysicalKey(this.deps.scope, key);
  }

  private schemaDriverPromise: Promise<SchemaTableDriver | undefined> | undefined;

  private async schemaDriver(): Promise<SchemaTableDriver | undefined> {
    if (this.schemaDriverPromise) return this.schemaDriverPromise;
    this.schemaDriverPromise = (async () => {
      if (!this.deps.schema && !this.deps.schemaName) return undefined;
      const driver = await this.deps.getDriver();
      if (!driver.openSchemaTable) {
        if (this.deps.schema) throw new KvdbError("UNSUPPORTED", "Driver does not support physical schema tables");
        return undefined;
      }
      try {
        return await driver.openSchemaTable(this.deps.schemaName ?? this.namespace, this.deps.schema);
      } catch {
        return undefined;
      }
    })();
    return this.schemaDriverPromise;
  }

  async set(key: string | number, value: Value, options: SetOptions<Columns> = {}): Promise<void> {
    // KD-7: storing undefined is a deletion.
    if (value === undefined) {
      await this.delete(key);
      return;
    }
    const strKey = String(key);
    const before = this.deps.hooks.has("beforeWrite")
      ? await this.deps.hooks.run("beforeWrite", {
          namespace: this.namespace,
          key: strKey,
          value: value as JsonValue,
          ttlMs: options.ttlMs,
        })
      : {
          namespace: this.namespace,
          key: strKey,
          value: value as JsonValue,
          ttlMs: options.ttlMs,
        };

    const schema = await this.schemaDriver();
    const cKey = this.cacheKey(strKey, Boolean(schema));
    if (schema) {
      const rawKeys = (options.keys ?? options.columns) as Record<string, unknown> | undefined;
      const columns = validateColumnValues(schema.schema, rawKeys);
      await schema.setRecord(key, serialize(before.value), columns, before.ttlMs);
      if (this.deps.cache) await this.deps.cache.set(cKey, before.value, before.ttlMs);
      if (this.deps.hooks.has("afterWrite")) {
        await this.deps.hooks.run("afterWrite", before);
      }
      return;
    }

    const driver = await this.deps.getDriver();
    await driver.set(cKey, serialize(before.value), before.ttlMs);
    if (this.deps.cache) await this.deps.cache.set(cKey, before.value, before.ttlMs);
    if (this.deps.hooks.has("afterWrite")) {
      await this.deps.hooks.run("afterWrite", before);
    }
  }

  /**
   * Partially update an existing value (atomic read-modify-write).
   *
   * - **Object patch** (`{ age: 21 }`): shallow-merges its top-level fields into
   *   the stored object (`{ ...current, ...patch }`). Set a field to `undefined`
   *   in the patch to drop it (canonical JSON semantics, see core/serializer.ts).
   * - **Function patch** (`(current) => next`): receives the current value and
   *   returns the next one — use this for nested or computed edits.
   *
   * The merge runs *inside the driver's transaction* with the row locked, so
   * concurrent updates to the same key serialize instead of clobbering each
   * other (drivers/types.ts `update`). Behaviour is identical on every backend.
   *
   * The existing TTL is preserved unless `options.ttlMs` overrides it. Throws
   * `KvdbError("QUERY")` if the key does not exist (use {@link set} to create).
   * Returns the value that was written. Note: because the merge happens under
   * the lock (where async hooks cannot run), `update` fires `afterWrite` but not
   * `beforeWrite` — use {@link set} when a plugin must rewrite the value.
   */
  async update(
    key: string | number,
    patch: UpdatePatch<Value>,
    options: SetOptions = {},
  ): Promise<Value> {
    const strKey = String(key);
    const schema = await this.schemaDriver();
    const cKey = this.cacheKey(strKey, Boolean(schema));
    if (schema) {
      let written!: Value;
      let writtenTtl: number | undefined;

      if (schema.updateRecord) {
        await schema.updateRecord(key, (current) => {
          if (current === undefined) {
            throw new KvdbError(
              "QUERY",
              `Cannot update key "${key}" in namespace "${this.deps.schemaName ?? this.namespace}": it does not exist`,
            );
          }
          written = applyPatch(deserialize<Value>(current.value), patch);
          writtenTtl = options.ttlMs ?? ttlFromExpiry(current.expiresAt);
          return { value: serialize(written as JsonValue), ttlMs: writtenTtl };
        });
      } else {
        const record = await schema.getRecord(key);
        if (record === undefined) {
          throw new KvdbError(
            "QUERY",
            `Cannot update key "${key}" in namespace "${this.deps.schemaName ?? this.namespace}": it does not exist`,
          );
        }
        written = applyPatch(deserialize<Value>(record.value), patch);
        writtenTtl = options.ttlMs ?? ttlFromExpiry(record.expiresAt);
        await schema.setRecord(key, serialize(written as JsonValue), record.columns, writtenTtl);
      }

      if (this.deps.cache) await this.deps.cache.set(cKey, written, writtenTtl);
      if (this.deps.hooks.has("afterWrite")) {
        await this.deps.hooks.run("afterWrite", {
          namespace: this.namespace,
          key: strKey,
          value: written as JsonValue,
          ttlMs: writtenTtl,
        });
      }
      return written;
    }

    const driver = await this.deps.getDriver();
    let written!: Value;
    let writtenTtl: number | undefined;
    // Pure read→merge→serialize, run by the driver under the row lock.
    const mutate = (current: RawEntry | undefined): UpdateResult => {
      if (current === undefined) {
        throw new KvdbError(
          "QUERY",
          `Cannot update key "${strKey}" in namespace "${this.namespace}": it does not exist`,
        );
      }
      written = applyPatch(deserialize<Value>(current.value), patch);
      writtenTtl = options.ttlMs ?? ttlFromExpiry(current.expiresAt);
      return { value: serialize(written), ttlMs: writtenTtl };
    };

    if (driver.update) {
      await driver.update(cKey, mutate);
    } else {
      // Non-atomic fallback for custom drivers without a native atomic update.
      const result = mutate(await driver.get(cKey));
      await driver.set(cKey, result.value, result.ttlMs);
    }

    if (this.deps.cache) await this.deps.cache.set(cKey, written, writtenTtl);
    if (this.deps.hooks.has("afterWrite")) {
      await this.deps.hooks.run("afterWrite", {
        namespace: this.namespace,
        key: strKey,
        value: written as JsonValue,
        ttlMs: writtenTtl,
      });
    }
    return written;
  }

  async get(key: string | number): Promise<Value | undefined> {
    const strKey = String(key);
    if (this.deps.hooks.has("beforeRead")) {
      await this.deps.hooks.run("beforeRead", { namespace: this.namespace, key: strKey, value: undefined });
    }

    const schema = await this.schemaDriver();
    const cKey = this.cacheKey(strKey, Boolean(schema));
    let value: Value | undefined;
    const cached = this.deps.cache ? await this.deps.cache.get<Value>(cKey) : undefined;
    if (cached !== undefined) {
      value = cached;
    } else if (schema) {
      const record = await schema.getRecord(key);
      if (record !== undefined) {
        value = deserialize<Value>(record.value);
        if (this.deps.cache) {
          const remainingTtl = ttlFromExpiry(record.expiresAt);
          await this.deps.cache.set(cKey, value, remainingTtl);
        }
      }
    } else {
      const driver = await this.deps.getDriver();
      const entry = await driver.get(cKey);
      if (entry !== undefined) {
        value = deserialize<Value>(entry.value);
        if (this.deps.cache) {
          const remainingTtl = ttlFromExpiry(entry.expiresAt);
          await this.deps.cache.set(cKey, value, remainingTtl);
        }
      }
    }

    if (this.deps.hooks.has("afterRead")) {
      const after = await this.deps.hooks.run("afterRead", {
        namespace: this.namespace,
        key: strKey,
        value: value as JsonValue | undefined,
      });
      return after.value as Value | undefined;
    }
    return value;
  }


  async delete(key: string | number): Promise<boolean> {
    const strKey = String(key);
    const schema = await this.schemaDriver();
    const cKey = this.cacheKey(strKey, Boolean(schema));
    if (this.deps.cache) await this.deps.cache.delete(cKey);
    if (schema) {
      return schema.delete(key);
    }
    const driver = await this.deps.getDriver();
    return driver.delete(cKey);
  }

  async exists(key: string | number): Promise<boolean> {
    const schema = await this.schemaDriver();
    if (schema) return (await schema.getRecord(key)) !== undefined;
    const driver = await this.deps.getDriver();
    return driver.has(toPhysicalKey(this.deps.scope, String(key)));
  }

  /** Clear this namespace only (not the whole backend). */
  async clear(): Promise<void> {
    const schema = await this.schemaDriver();
    if (schema) {
      await schema.clear();
      return;
    }
    const driver = await this.deps.getDriver();
    await driver.deleteByPrefix(namespacePrefix(this.deps.scope));
  }

  async getMany(keys: (string | number)[]): Promise<(Value | undefined)[]> {
    const schema = await this.schemaDriver();
    if (schema) {
      return Promise.all(keys.map((k) => this.get(k)));
    }
    const driver = await this.deps.getDriver();
    const strKeys = keys.map(String);
    const physicalKeys = strKeys.map((key) => toPhysicalKey(this.deps.scope, key));
    const entries = driver.getMany
      ? await driver.getMany(physicalKeys)
      : await Promise.all(physicalKeys.map((key) => driver.get(key)));
    return entries.map((entry) =>
      entry === undefined ? undefined : deserialize<Value>(entry.value),
    );
  }

  async setMany(
    items: {
      key: string | number;
      value: Value;
      ttlMs?: number;
      keys?: Record<string, unknown>;
      columns?: Record<string, unknown>;
    }[],
  ): Promise<void> {
    const schema = await this.schemaDriver();
    if (schema) {
      const recordsToSet = items.map((item) => {
        const rawKeys = (item.keys ?? item.columns) as Record<string, unknown> | undefined;
        const columns = validateColumnValues(schema.schema, rawKeys);
        return {
          key: item.key,
          value: serialize(item.value),
          columns,
          ttlMs: item.ttlMs,
        };
      });
      if (schema.setRecords) {
        await schema.setRecords(recordsToSet);
      } else {
        for (const item of recordsToSet) {
          await schema.setRecord(item.key, item.value, item.columns, item.ttlMs);
        }
      }
      if (this.deps.cache) {
        await Promise.all(
          items.map((item) =>
            this.deps.cache!.set(
              this.cacheKey(String(item.key), true),
              item.value,
              item.ttlMs,
            ),
          ),
        );
      }
      return;
    }
    const driver = await this.deps.getDriver();
    const entries = items.map((item) => ({
      key: toPhysicalKey(this.deps.scope, String(item.key)),
      value: serialize(item.value),
      ttlMs: item.ttlMs,
    }));
    if (driver.setMany) {
      await driver.setMany(entries);
    } else {
      for (const entry of entries) await driver.set(entry.key, entry.value, entry.ttlMs);
    }
    if (this.deps.cache) {
      await Promise.all(
        items.map((item) =>
          this.deps.cache!.set(
            toPhysicalKey(this.deps.scope, String(item.key)),
            item.value,
            item.ttlMs,
          ),
        ),
      );
    }
  }

  async deleteMany(keys: (string | number)[]): Promise<number> {
    const schema = await this.schemaDriver();
    if (schema) {
      let count = 0;
      if (schema.deleteRecords) {
        count = await schema.deleteRecords(keys);
      } else {
        for (const key of keys) {
          if (await this.delete(key)) count++;
        }
      }
      if (this.deps.cache) {
        await Promise.all(
          keys.map((key) => this.deps.cache!.delete(this.cacheKey(String(key), true))),
        );
      }
      return count;
    }
    const driver = await this.deps.getDriver();
    const strKeys = keys.map(String);
    const physicalKeys = strKeys.map((key) => toPhysicalKey(this.deps.scope, key));
    const count = driver.deleteMany
      ? await driver.deleteMany(physicalKeys)
      : await physicalKeys.reduce(
          async (acc, key) => (await acc) + ((await driver.delete(key)) ? 1 : 0),
          Promise.resolve(0),
        );
    if (this.deps.cache) {
      await Promise.all(physicalKeys.map((key) => this.deps.cache!.delete(key)));
    }
    return count;
  }

  async getByPrefix(prefix: string): Promise<{ key: string; value: Value }[]> {
    const schema = await this.schemaDriver();
    if (schema) {
      throw new KvdbError(
        "UNSUPPORTED",
        "Prefix scan operations (getByPrefix) are not supported on physical schema tables; use find() instead.",
      );
    }
    const driver = await this.deps.getDriver();
    const physicalPrefix = toPhysicalPrefix(this.deps.scope, prefix);
    const entries = await driver.getByPrefix(physicalPrefix);
    return entries.map((entry) => ({
      key: toUserKey(this.deps.scope, entry.key),
      value: deserialize<Value>(entry.value),
    }));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const schema = await this.schemaDriver();
    if (schema) {
      throw new KvdbError(
        "UNSUPPORTED",
        "Prefix scan operations (deleteByPrefix) are not supported on physical schema tables; use find() instead.",
      );
    }
    const driver = await this.deps.getDriver();
    return driver.deleteByPrefix(toPhysicalPrefix(this.deps.scope, prefix));
  }

  async find(query: FindQuery = {}): Promise<{ key: string; value: Value }[]> {
    const schema = await this.schemaDriver();
    if (schema) {
      const mergedWhere = {
        ...(query.where ?? {}),
        ...(query.columns ? { columns: query.columns } : {}),
      };
      const whereNode = parseSchemaWhere(mergedWhere, schema.schema);
      const findOpts = parseFindOptions(query, schema.schema);
      const rows = await schema.find(whereNode, findOpts);
      return rows.map((row) => ({ key: String(row.key), value: deserialize<Value>(row.value) }));
    }

    const driver = await this.deps.getDriver();
    const whereParsed = parseWhere(query.where);
    const findOpts = parseFindOptions(query);
    const parsed = this.deps.hooks.has("beforeQuery")
      ? await this.deps.hooks.run("beforeQuery", {
          namespace: this.namespace,
          where: whereParsed,
          options: findOpts,
        })
      : {
          namespace: this.namespace,
          where: whereParsed,
          options: findOpts,
        };
    const entries = await driver.find(
      parsed.where,
      parsed.options,
      namespacePrefix(this.deps.scope),
    );
    if (this.deps.hooks.has("afterQuery")) {
      await this.deps.hooks.run("afterQuery", parsed);
    }

    if (this.deps.autoIndex) {
      const paths = collectFieldPaths(parsed.where, parsed.options?.sort);
      const scopedPaths = paths.map((path) => `${this.namespace}::${path}`);
      const toIndex = this.deps.autoIndex.record(scopedPaths);
      if (toIndex.length > 0) {
        void Promise.all(
          toIndex.map((scopedPath) => {
            const path = scopedPath.slice(this.namespace.length + 2);
            return Promise.resolve(driver.ensureIndex(path)).catch(() => {});
          }),
        );

      }
    }
    return entries.map((entry) => ({
      key: toUserKey(this.deps.scope, entry.key),
      value: deserialize<Value>(entry.value),
    }));
  }


  async findRecords(query: FindQuery = {}): Promise<PhysicalRecord<Columns, Value>[]> {
    const schema = await this.schemaDriver();
    if (!schema) {
      const items = await this.find(query);
      return items.map((item) => ({
        key: item.key as any,
        columns: {} as Partial<Columns>,
        keys: {} as Partial<Columns>,
        value: item.value,
      }));
    }
    const mergedWhere = {
      ...(query.where ?? {}),
      ...(query.columns ? { columns: query.columns } : {}),
    };
    const whereNode = parseSchemaWhere(mergedWhere, schema.schema);
    const findOpts = parseFindOptions(query, schema.schema);
    const rows = await schema.find(whereNode, findOpts);
    return rows.map((row) => ({
      key: row.key as any,
      columns: row.columns as Partial<Columns>,
      keys: row.columns as Partial<Columns>,
      value: deserialize<Value>(row.value),
    }));
  }

  async getRecord(key: string | number): Promise<PhysicalRecord<Columns, Value> | undefined> {
    const schema = await this.schemaDriver();
    if (!schema) {
      const value = await this.get(key);
      return value === undefined ? undefined : { key: key as any, columns: {} as Partial<Columns>, keys: {} as Partial<Columns>, value };
    }
    const record = await schema.getRecord(key);
    return record
      ? {
          key: record.key as any,
          columns: record.columns as Partial<Columns>,
          keys: record.columns as Partial<Columns>,
          value: deserialize<Value>(record.value),
        }
      : undefined;
  }

  /**
   * Fast O(1) point lookup by any indexed secondary key.
   */
  async getBy(keyName: string, keyValue: unknown): Promise<PhysicalRecord<Columns, Value> | undefined> {
    const schema = await this.schemaDriver();
    if (!schema) {
      throw new KvdbError(
        "UNSUPPORTED",
        `Cannot getBy on table "${this.deps.schemaName ?? this.namespace}": not a physical schema table`,
      );
    }
    if (!schema.getRecordByKey) {
      throw new KvdbError("UNSUPPORTED", "Driver does not support getRecordByKey");
    }
    const record = await schema.getRecordByKey(keyName, keyValue);
    return record
      ? {
          key: record.key as any,
          columns: record.columns as Partial<Columns>,
          keys: record.columns as Partial<Columns>,
          value: deserialize<Value>(record.value),
        }
      : undefined;
  }

  async ensureIndex(jsonPath: string): Promise<void> {
    const driver = await this.deps.getDriver();
    await driver.ensureIndex(jsonPath);
  }

  /**
   * Dynamically add a secondary key to this table and evolve underlying physical schema.
   */
  async addKey(name: string, definition: KeyDefinition): Promise<void> {
    const schemaDriver = await this.schemaDriver();
    if (!schemaDriver) {
      throw new KvdbError(
        "UNSUPPORTED",
        `Cannot add key "${name}": table "${this.deps.schemaName ?? this.namespace}" is not a physical schema table`,
      );
    }
    if (!schemaDriver.addKey) {
      throw new KvdbError("UNSUPPORTED", "Driver does not support dynamic key addition");
    }
    await schemaDriver.addKey(name, definition);
    this.deps.schema = schemaDriver.schema;
  }

  /**
   * Dynamically add an index to this table.
   */
  async addIndex(definition: TableIndexDefinition | MultiKeyIndexDefinition): Promise<void> {
    const schemaDriver = await this.schemaDriver();
    if (!schemaDriver) {
      throw new KvdbError(
        "UNSUPPORTED",
        `Cannot add index: table "${this.deps.schemaName ?? this.namespace}" is not a physical schema table`,
      );
    }
    if (!schemaDriver.addIndex) {
      throw new KvdbError("UNSUPPORTED", "Driver does not support dynamic index addition");
    }
    await schemaDriver.addIndex(definition);
    this.deps.schema = schemaDriver.schema;
  }
}


/** Apply an {@link UpdatePatch} to the current value (see {@link Table.update}). */
function applyPatch<Value>(current: Value, patch: UpdatePatch<Value>): Value {
  if (typeof patch === "function") {
    return (patch as (current: Value) => Value)(current);
  }
  if (!isPlainObject(current) || !isPlainObject(patch)) {
    throw new KvdbError(
      "QUERY",
      "An object patch requires both the stored value and the patch to be plain " +
        "objects; use the function form `(current) => next` for other shapes",
    );
  }
  const safePatch: Record<string, unknown> = {};
  for (const k of Object.keys(patch as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    safePatch[k] = (patch as Record<string, unknown>)[k];
  }
  return { ...current, ...safePatch } as Value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remaining TTL (relative ms) from an absolute expiry, or `undefined` if none. */
function ttlFromExpiry(expiresAt?: number): number | undefined {
  if (expiresAt === undefined) return undefined;
  const remaining = expiresAt - Date.now();
  return remaining > 0 ? remaining : 1;
}
