// Table / Namespace — the CRUD + Query facade users operate on (docs/SPEC.md §3-6).
//
// A Table owns no connection; it asks its parent KVDB for the (lazily connected)
// Driver on each call. It is the single place that:
//   - turns user keys into physical keys (core/key.ts),
//   - (de)serializes values (core/serializer.ts),
//   - parses user query documents into the AST (query/parser.ts),
//   - applies the optional point-read cache.
// Drivers see only physical keys and canonical JSON — never user-facing shapes.

import type { Driver } from "../drivers/types.js";
import type { Cache } from "../cache/cache.js";
import type { JsonValue } from "../types/json.js";
import { serialize, deserialize } from "./serializer.js";
import { toPhysicalKey, toUserKey, toPhysicalPrefix, namespacePrefix } from "./key.js";
import type { KeyScope } from "./key.js";
import { parseWhere, parseFindOptions } from "../query/parser.js";

/** User-facing query document for `find` (parsed into the AST internally). */
export interface FindQuery {
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  sort?: { path: string; direction?: "asc" | "desc" }[];
}

export interface SetOptions {
  ttlMs?: number;
}

export interface TableDependencies {
  /** Resolve the lazily-connected driver. */
  getDriver: () => Promise<Driver>;
  scope: KeyScope;
  /** Optional point-read cache shared from the KVDB instance. */
  cache?: Cache;
}

export class Table<Value = JsonValue> {
  constructor(private readonly deps: TableDependencies) {}

  async set(key: string, value: Value, options: SetOptions = {}): Promise<void> {
    // KD-7: storing undefined is a deletion.
    if (value === undefined) {
      await this.delete(key);
      return;
    }
    const driver = await this.deps.getDriver();
    const physicalKey = toPhysicalKey(this.deps.scope, key);
    const text = serialize(value);
    await driver.set(physicalKey, text, options.ttlMs);
    if (this.deps.cache) await this.deps.cache.set(physicalKey, value, options.ttlMs);
  }

  async get(key: string): Promise<Value | undefined> {
    const physicalKey = toPhysicalKey(this.deps.scope, key);
    if (this.deps.cache) {
      const cached = await this.deps.cache.get<Value>(physicalKey);
      if (cached !== undefined) return cached;
    }
    const driver = await this.deps.getDriver();
    const entry = await driver.get(physicalKey);
    if (entry === undefined) return undefined;
    const value = deserialize<Value>(entry.value);
    if (this.deps.cache) await this.deps.cache.set(physicalKey, value);
    return value;
  }

  async delete(key: string): Promise<boolean> {
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
    const driver = await this.deps.getDriver();
    const where = parseWhere(query.where);
    const options = parseFindOptions(query);
    const entries = await driver.find(where, options);
    return entries.map((entry) => ({
      key: toUserKey(this.deps.scope, entry.key),
      value: deserialize<Value>(entry.value),
    }));
  }

  async ensureIndex(jsonPath: string): Promise<void> {
    const driver = await this.deps.getDriver();
    await driver.ensureIndex(jsonPath);
  }
}
