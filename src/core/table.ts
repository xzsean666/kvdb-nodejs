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
import { collectFieldPaths } from "../query/paths.js";
import type { HookRuntime } from "../plugins/runtime.js";
import type { AutoIndexManager } from "./auto-index.js";

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
  /** Hook runtime (no-op when no plugins are registered). */
  hooks: HookRuntime;
  /** Optional auto-index manager (opt-in via KVDBOptions.autoIndex). */
  autoIndex?: AutoIndexManager;
}

export class Table<Value = JsonValue> {
  constructor(private readonly deps: TableDependencies) {}

  private get namespace(): string {
    return this.deps.scope.namespace;
  }

  async set(key: string, value: Value, options: SetOptions = {}): Promise<void> {
    // KD-7: storing undefined is a deletion.
    if (value === undefined) {
      await this.delete(key);
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

  async get(key: string): Promise<Value | undefined> {
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

  async ensureIndex(jsonPath: string): Promise<void> {
    const driver = await this.deps.getDriver();
    await driver.ensureIndex(jsonPath);
  }
}
