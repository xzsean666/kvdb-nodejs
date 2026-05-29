// Cache — tiered multi-store cache facade (docs/ARCHITECTURE.md KD-4).
//
// A Cache wraps an ordered list of KVStore tiers (e.g. memory -> sqlite-memory
// -> sqlite-file). Reads return the first live hit and backfill higher tiers;
// writes go to every tier. `wrap()` memoizes a function's result with optional
// stale-while-revalidate (refreshThreshold), and is the engine the @Cacheable
// decorator delegates to.
//
// Value (de)serialization is centralized in core/serializer.ts; stores only
// ever hold canonical JSON text.

import type { KVStore, RawEntry } from "./types.js";
import { MemoryStore } from "./stores/memory-store.js";
import { SqliteCacheStore } from "./stores/sqlite-store.js";
import { serialize, deserialize } from "../core/serializer.js";
import { remainingTtl } from "../core/expiry.js";
import { KvdbConfigError } from "../core/errors.js";

/** A store, or shorthand spec resolved into one. */
export type CacheStoreSpec =
  | KVStore
  | "memory"
  | "sqlite-memory"
  | { driver: "memory"; max?: number }
  | { driver: "sqlite-memory"; table?: string }
  | { driver: "sqlite"; file: string; table?: string };

export interface CacheOptions {
  /** Ordered tiers, highest priority first. */
  stores?: CacheStoreSpec[];
  /** Shorthand for a single-tier cache. Ignored if `stores` is given. */
  driver?: CacheStoreSpec;
  /** Default TTL (ms) applied when a write omits one. */
  defaultTtlMs?: number;
}

export interface WrapOptions {
  ttlMs?: number;
  /**
   * If the cached entry's remaining TTL drops below this many ms, `wrap`
   * returns the stale value and refreshes it in the background.
   */
  refreshThreshold?: number;
}

function isKVStore(spec: CacheStoreSpec): spec is KVStore {
  return typeof spec === "object" && typeof (spec as KVStore).get === "function";
}

function resolveStore(spec: CacheStoreSpec): KVStore {
  if (isKVStore(spec)) return spec;
  if (spec === "memory") return new MemoryStore();
  if (spec === "sqlite-memory") return new SqliteCacheStore({ file: ":memory:" });
  if (typeof spec === "object") {
    switch (spec.driver) {
      case "memory":
        return new MemoryStore({ max: spec.max });
      case "sqlite-memory":
        return new SqliteCacheStore({ file: ":memory:", table: spec.table });
      case "sqlite":
        return new SqliteCacheStore({ file: spec.file, table: spec.table });
    }
  }
  throw new KvdbConfigError(`Unsupported cache store spec: ${JSON.stringify(spec)}`);
}

export class Cache {
  private readonly stores: KVStore[];
  private readonly defaultTtlMs: number | undefined;
  private readonly refreshing = new Set<string>();

  constructor(options: CacheOptions = {}) {
    const specs =
      options.stores ?? (options.driver ? [options.driver] : ["memory" as const]);
    if (specs.length === 0) {
      throw new KvdbConfigError("Cache requires at least one store");
    }
    this.stores = specs.map(resolveStore);
    this.defaultTtlMs = options.defaultTtlMs;
  }

  async get<V>(key: string): Promise<V | undefined> {
    const hit = await this.readRaw(key);
    return hit === undefined ? undefined : deserialize<V>(hit.value);
  }

  async set<V>(key: string, value: V, ttlMs?: number): Promise<void> {
    if (value === undefined) {
      await this.delete(key);
      return;
    }
    const text = serialize(value);
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    await Promise.all(this.stores.map((store) => store.set(key, text, effectiveTtl)));
  }

  async delete(key: string): Promise<boolean> {
    const results = await Promise.all(this.stores.map((store) => store.delete(key)));
    return results.some(Boolean);
  }

  async clear(): Promise<void> {
    await Promise.all(this.stores.map((store) => store.clear()));
  }

  async wrap<V>(key: string, fn: () => Promise<V>, options: WrapOptions = {}): Promise<V> {
    const hit = await this.readRaw(key);
    if (hit !== undefined) {
      const value = deserialize<V>(hit.value);
      const threshold = options.refreshThreshold;
      if (threshold !== undefined && remainingTtl(hit, Date.now()) < threshold) {
        this.refreshInBackground(key, fn, options.ttlMs);
      }
      return value;
    }
    const value = await fn();
    await this.set(key, value, options.ttlMs);
    return value;
  }

  /** Read the first live entry across tiers, backfilling higher (closer) tiers. */
  private async readRaw(key: string): Promise<RawEntry | undefined> {
    for (let tier = 0; tier < this.stores.length; tier++) {
      const store = this.stores[tier]!;
      const entry = await store.get(key);
      if (entry === undefined) continue;
      if (tier > 0) await this.backfill(key, entry, tier);
      return entry;
    }
    return undefined;
  }

  /** Populate tiers above the one that produced the hit, preserving remaining TTL. */
  private async backfill(key: string, entry: RawEntry, foundTier: number): Promise<void> {
    const remaining = remainingTtl(entry, Date.now());
    const ttlMs = remaining === Infinity ? undefined : Math.max(1, Math.floor(remaining));
    for (let tier = 0; tier < foundTier; tier++) {
      await this.stores[tier]!.set(key, entry.value, ttlMs);
    }
  }

  private refreshInBackground<V>(
    key: string,
    fn: () => Promise<V>,
    ttlMs: number | undefined,
  ): void {
    if (this.refreshing.has(key)) return;
    this.refreshing.add(key);
    void (async () => {
      try {
        const value = await fn();
        await this.set(key, value, ttlMs);
      } catch {
        // Stale value was already returned to the caller; a failed background
        // refresh leaves the existing entry in place. Intentionally swallowed.
      } finally {
        this.refreshing.delete(key);
      }
    })();
  }
}
