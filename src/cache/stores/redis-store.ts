// Redis cache store backend implementing KVStore.

import type { KVStore, KVEntry, RawEntry } from "../types.js";
import { RedisDriver, type RedisDriverOptions } from "../../drivers/redis/redis-driver.js";
import { RedisDriverFactory } from "../../drivers/redis/redis-driver.js";

export class RedisStore implements KVStore {
  private driverPromise?: Promise<RedisDriver>;
  private driver?: RedisDriver;

  constructor(private readonly options: RedisDriverOptions = {}) {}

  private async getDriver(): Promise<RedisDriver> {
    if (!this.driver) {
      if (!this.driverPromise) {
        const factory = new RedisDriverFactory(this.options);
        this.driverPromise = (factory.connect() as Promise<RedisDriver>).catch((err) => {
          this.driverPromise = undefined;
          throw err;
        });
      }
      this.driver = await this.driverPromise;
    }
    return this.driver;
  }

  async get(key: string): Promise<RawEntry | undefined> {
    const d = await this.getDriver();
    return d.get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const d = await this.getDriver();
    return d.set(key, value, ttlMs);
  }

  async delete(key: string): Promise<boolean> {
    const d = await this.getDriver();
    return d.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const d = await this.getDriver();
    return d.has(key);
  }

  async clear(): Promise<void> {
    const d = await this.getDriver();
    return d.clear();
  }

  async getMany(keys: string[]): Promise<(RawEntry | undefined)[]> {
    const d = await this.getDriver();
    return d.getMany(keys);
  }

  async setMany(entries: KVEntry[]): Promise<void> {
    const d = await this.getDriver();
    return d.setMany(entries);
  }

  async deleteMany(keys: string[]): Promise<number> {
    const d = await this.getDriver();
    return d.deleteMany(keys);
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    const d = await this.getDriver();
    yield* d.iterator(prefix);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const d = await this.getDriver();
    return d.deleteByPrefix(prefix);
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = undefined;
      this.driverPromise = undefined;
    }
  }
}
