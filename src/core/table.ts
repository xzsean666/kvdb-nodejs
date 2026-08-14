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
import type { TableSchema, PhysicalRecord } from "./table-schema.js";
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

export interface SetOptions {
  ttlMs?: number;
  columns?: Record<string, unknown>;
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
  schema?: TableSchema;
}

export class Table<Value = JsonValue, Columns extends Record<string, unknown> = Record<string, unknown>> {
  constructor(private readonly deps: TableDependencies) {}

  private get namespace(): string {
    return this.deps.scope.namespace;
  }

  private async schemaDriver(): Promise<SchemaTableDriver | undefined> {
    if (!this.deps.schemaName) return undefined;
    const driver = await this.deps.getDriver();
    if (!driver.openSchemaTable) {
      if (this.deps.schema) throw new KvdbError("UNSUPPORTED", "Driver does not support physical schema tables");
      return undefined;
    }
    return driver.openSchemaTable(this.deps.schemaName, this.deps.schema);
  }

  async set(key: string, value: Value, options: SetOptions = {}): Promise<void> {
    // KD-7: storing undefined is a deletion.
    if (value === undefined) {
      await this.delete(key);
      return;
    }
    const schema = await this.schemaDriver();
    if (schema) {
      const columns = validateColumnValues(schema.schema, options.columns);
      schema.setRecord(key, serialize(value as JsonValue), columns, options.ttlMs);
      return;
    }
    const before = await this.deps.hooks.run("beforeWrite", {
      namespace: this.namespace,
      key,
      value: value as JsonValue,
      ttlMs: options.ttlMs,
    });
    const driver = await this.deps.getDriver();
    const physicalKey = toPhysicalKey(this.deps.scope, before.key);
    await driver.set(physicalKey, serialize(before.value), before.ttlMs);
    if (this.deps.cache) await this.deps.cache.set(physicalKey, before.value, before.ttlMs);
    await this.deps.hooks.run("afterWrite", before);
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
    key: string,
    patch: UpdatePatch<Value>,
    options: SetOptions = {},
  ): Promise<Value> {
    const driver = await this.deps.getDriver();
    const physicalKey = toPhysicalKey(this.deps.scope, key);

    let written!: Value;
    let writtenTtl: number | undefined;
    // Pure read→merge→serialize, run by the driver under the row lock.
    const mutate = (current: RawEntry | undefined): UpdateResult => {
      if (current === undefined) {
        throw new KvdbError(
          "QUERY",
          `Cannot update key "${key}" in namespace "${this.namespace}": it does not exist`,
        );
      }
      written = applyPatch(deserialize<Value>(current.value), patch);
      writtenTtl = options.ttlMs ?? ttlFromExpiry(current.expiresAt);
      return { value: serialize(written), ttlMs: writtenTtl };
    };

    if (driver.update) {
      await driver.update(physicalKey, mutate);
    } else {
      // Non-atomic fallback for custom drivers without a native atomic update.
      const result = mutate(await driver.get(physicalKey));
      await driver.set(physicalKey, result.value, result.ttlMs);
    }

    if (this.deps.cache) await this.deps.cache.set(physicalKey, written, writtenTtl);
    await this.deps.hooks.run("afterWrite", {
      namespace: this.namespace,
      key,
      value: written as JsonValue,
      ttlMs: writtenTtl,
    });
    return written;
  }

  async get(key: string): Promise<Value | undefined> {
    const schema = await this.schemaDriver();
    if (schema) {
      const record = await schema.getRecord(key);
      return record ? deserialize<Value>(record.value) : undefined;
    }
    const physicalKey = toPhysicalKey(this.deps.scope, key);
    await this.deps.hooks.run("beforeRead", { namespace: this.namespace, key, value: undefined });

    let value: Value | undefined;
    const cached = this.deps.cache ? await this.deps.cache.get<Value>(physicalKey) : undefined;
    if (cached !== undefined) {
      value = cached;
    } else {
      const driver = await this.deps.getDriver();
      const entry = await driver.get(physicalKey);
      if (entry !== undefined) {
        value = deserialize<Value>(entry.value);
        if (this.deps.cache) await this.deps.cache.set(physicalKey, value);
      }
    }

    const after = await this.deps.hooks.run("afterRead", {
      namespace: this.namespace,
      key,
      value: value as JsonValue | undefined,
    });
    return after.value as Value | undefined;
  }

  async delete(key: string): Promise<boolean> {
    const schema = await this.schemaDriver();
    if (schema) return schema.delete(key);
    const driver = await this.deps.getDriver();
    const physicalKey = toPhysicalKey(this.deps.scope, key);
    const deleted = await driver.delete(physicalKey);
    if (this.deps.cache) await this.deps.cache.delete(physicalKey);
    return deleted;
  }

  async exists(key: string): Promise<boolean> {
    const driver = await this.deps.getDriver();
    return driver.has(toPhysicalKey(this.deps.scope, key));
  }

  /** Clear this namespace only (not the whole backend). */
  async clear(): Promise<void> {
    const schema = await this.schemaDriver();
    if (schema) { await schema.clear(); return; }
    const driver = await this.deps.getDriver();
    await driver.deleteByPrefix(namespacePrefix(this.deps.scope));
    // The shared cache may hold other namespaces; clear by prefix is not
    // available on Cache, so callers relying on cache should scope per table.
  }

  async getMany(keys: string[]): Promise<(Value | undefined)[]> {
    const driver = await this.deps.getDriver();
    const physicalKeys = keys.map((key) => toPhysicalKey(this.deps.scope, key));
    const entries = driver.getMany
      ? await driver.getMany(physicalKeys)
      : await Promise.all(physicalKeys.map((key) => driver.get(key)));
    return entries.map((entry) =>
      entry === undefined ? undefined : deserialize<Value>(entry.value),
    );
  }

  async setMany(items: { key: string; value: Value; ttlMs?: number }[]): Promise<void> {
    const driver = await this.deps.getDriver();
    const entries = items.map((item) => ({
      key: toPhysicalKey(this.deps.scope, item.key),
      value: serialize(item.value),
      ttlMs: item.ttlMs,
    }));
    if (driver.setMany) {
      await driver.setMany(entries);
    } else {
      for (const entry of entries) await driver.set(entry.key, entry.value, entry.ttlMs);
    }
    if (this.deps.cache) {
      await Promise.all(items.map((item) =>
        this.deps.cache!.set(toPhysicalKey(this.deps.scope, item.key), item.value, item.ttlMs),
      ));
    }
  }

  async deleteMany(keys: string[]): Promise<number> {
    const driver = await this.deps.getDriver();
    const physicalKeys = keys.map((key) => toPhysicalKey(this.deps.scope, key));
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
    const driver = await this.deps.getDriver();
    const physicalPrefix = toPhysicalPrefix(this.deps.scope, prefix);
    const entries = await driver.getByPrefix(physicalPrefix);
    return entries.map((entry) => ({
      key: toUserKey(this.deps.scope, entry.key),
      value: deserialize<Value>(entry.value),
    }));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const driver = await this.deps.getDriver();
    return driver.deleteByPrefix(toPhysicalPrefix(this.deps.scope, prefix));
  }

  async find(query: FindQuery = {}): Promise<{ key: string; value: Value }[]> {
    const schema = await this.schemaDriver();
    if (schema) {
      const rows = await schema.find(parseSchemaWhere({ ...(query.where ?? {}), ...(query.columns ? { columns: query.columns } : {}) }), parseFindOptions(query));
      return rows.map((row) => ({ key: row.key, value: deserialize<Value>(row.value) }));
    }
    const driver = await this.deps.getDriver();
    const parsed = await this.deps.hooks.run("beforeQuery", {
      namespace: this.namespace,
      where: parseWhere(query.where),
      options: parseFindOptions(query),
    });
    const entries = await driver.find(
      parsed.where,
      parsed.options,
      namespacePrefix(this.deps.scope),
    );
    await this.deps.hooks.run("afterQuery", parsed);

    if (this.deps.autoIndex) {
      const paths = collectFieldPaths(parsed.where, parsed.options?.sort);
      for (const path of this.deps.autoIndex.record(paths)) {
        await driver.ensureIndex(path);
      }
    }
    return entries.map((entry) => ({
      key: toUserKey(this.deps.scope, entry.key),
      value: deserialize<Value>(entry.value),
    }));
  }

  async getRecord(key: string): Promise<PhysicalRecord<Record<string, unknown>, Value> | undefined> {
    const schema = await this.schemaDriver();
    if (!schema) {
      const value = await this.get(key);
      return value === undefined ? undefined : { key, columns: {}, value };
    }
    const record = await schema.getRecord(key);
    return record ? { key: record.key, columns: record.columns, value: deserialize<Value>(record.value) } : undefined;
  }

  async ensureIndex(jsonPath: string): Promise<void> {
    const driver = await this.deps.getDriver();
    await driver.ensureIndex(jsonPath);
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
  return { ...current, ...patch } as Value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remaining TTL (relative ms) from an absolute expiry, or `undefined` if none. */
function ttlFromExpiry(expiresAt?: number): number | undefined {
  if (expiresAt === undefined) return undefined;
  const remaining = expiresAt - Date.now();
  return remaining > 0 ? remaining : undefined;
}
