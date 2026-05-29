// In-memory KVStore backed by lru-cache v11 (docs/ARCHITECTURE.md KD-4, KD-5).
//
// Capacity is bounded by `max` (lru-cache requires a bound — an unbounded
// memory cache is an anti-pattern). Logical expiry is enforced here via the
// shared expiry helpers so behavior matches the SQLite/Postgres stores exactly.

import { LRUCache } from "lru-cache";
import type { KVStore, RawEntry } from "../types.js";
import { expiresAtFromTtl, isExpired } from "../../core/expiry.js";

export interface MemoryStoreOptions {
  /** Maximum number of entries before least-recently-used eviction. Default 1000. */
  max?: number;
}

export class MemoryStore implements KVStore {
  private readonly entries: LRUCache<string, RawEntry>;

  constructor(options: MemoryStoreOptions = {}) {
    this.entries = new LRUCache<string, RawEntry>({ max: options.max ?? 1000 });
  }

  get(key: string): RawEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (isExpired(entry, Date.now())) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: string, ttlMs?: number): void {
    this.entries.set(key, { value, expiresAt: expiresAtFromTtl(ttlMs, Date.now()) });
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue;
      if (isExpired(entry, now)) continue;
      yield [key, entry];
    }
  }
}
