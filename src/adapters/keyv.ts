// Keyv & Unstorage Ecosystem Adapter (docs/SPEC.md §22)
import type { Table } from "../core/table.js";

/**
 * Storage adapter conforming to the universal Keyv / Cache-Manager storage contract.
 */
export interface KeyvStoreAdapter<Value = unknown> {
  get(key: string): Promise<Value | undefined>;
  getMany?(keys: string[]): Promise<(Value | undefined)[]>;
  set(key: string, value: Value, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteMany?(keys: string[]): Promise<boolean>;
  clear(): Promise<void>;
  has?(key: string): Promise<boolean>;
  iterator?(namespace?: string): AsyncIterable<[string, Value]>;
}

/**
 * Wrap a KVDB Table into a standards-compliant Keyv storage adapter.
 */
export function createKeyvAdapter<Value = unknown>(
  table: Table<Value>,
): KeyvStoreAdapter<Value> {
  return {
    async get(key: string): Promise<Value | undefined> {
      return table.get(key);
    },

    async getMany(keys: string[]): Promise<(Value | undefined)[]> {
      return table.getMany(keys);
    },

    async set(key: string, value: Value, ttlMs?: number): Promise<void> {
      await table.set(key, value, { ttlMs });
    },

    async delete(key: string): Promise<boolean> {
      return table.delete(key);
    },

    async deleteMany(keys: string[]): Promise<boolean> {
      const count = await table.deleteMany(keys);
      return count > 0;
    },

    async clear(): Promise<void> {
      await table.clear();
    },

    async has(key: string): Promise<boolean> {
      return table.exists(key);
    },

    async *iterator(): AsyncIterable<[string, Value]> {
      const records = await table.find();
      for (const item of records) {
        yield [item.key, item.value];
      }
    },
  };
}
