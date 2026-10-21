// Redis driver implementation based on ioredis.
//
// Provides high-performance in-memory KV storage, native TTL expiration,
// prefix scanning with SCAN, optimistic concurrency via atomic Lua CAS scripts,
// and AST-level JSON querying.

import type { Redis } from "ioredis";
import type {
  Driver,
  DriverFactory,
  DriverCapabilities,
  ProviderName,
  UpdateMutator,
  UpdateResult,
} from "../types.js";
import type { KVEntry, RawEntry } from "../../cache/types.js";
import type { QueryNode, FindOptions } from "../../query/ast.js";
import { evaluateQuery, sortDocuments } from "../../query/evaluator.js";
import { deserialize } from "../../core/serializer.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";

const MAX_UPDATE_ATTEMPTS = 50;

const CAS_UPDATE_LUA = `
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]
if (expected == '__KVDB_NIL__' and current ~= false) or (expected ~= '__KVDB_NIL__' and current ~= expected) then
  local pttl = redis.call('PTTL', KEYS[1])
  return { 0, current or '__KVDB_NIL__', tostring(pttl) }
end
local ttl = tonumber(ARGV[3])
if ttl and ttl >= 0 then
  if ttl == 0 then
    redis.call('DEL', KEYS[1])
  else
    redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
  end
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return { 1, '', '0' }
`;

export interface RedisDriverOptions {
  /** Redis connection URL (e.g., "redis://127.0.0.1:6379" or "redis://localhost:6379/1"). */
  url?: string;
  /** An existing ioredis Redis instance. If provided, `url` is ignored. */
  client?: Redis;
  /** Optional key prefix for all keys managed by this driver instance. */
  keyPrefix?: string;
  /** Optional ioredis options (connectTimeout, retryStrategy, maxRetriesPerRequest, etc.). */
  redisOptions?: Record<string, unknown>;
  /**
   * If true, allows clear() to execute FLUSHDB when keyPrefix is empty.
   * Default: false (protects shared Redis instances from accidental total wipe).
   */
  allowFlushDbWithoutPrefix?: boolean;
}

let ioredisConstructor: any;

async function loadRedisClass(): Promise<any> {
  if (!ioredisConstructor) {
    try {
      const mod = await import("ioredis");
      ioredisConstructor = mod.default || mod;
    } catch {
      throw new KvdbConfigError(
        "The 'ioredis' package is required to use the Redis driver. Install it with: pnpm add ioredis",
      );
    }
  }
  return ioredisConstructor;
}

export class RedisDriverFactory implements DriverFactory {
  readonly provider: ProviderName = "redis";
  readonly capabilities: DriverCapabilities = {
    nativeTtl: true,
    jsonQuery: "none",
    managesOwnPool: true,
    supportsTransactions: true,
    supportsPrefixScan: true,
  };

  constructor(private readonly options: RedisDriverOptions = {}) {}

  async connect(): Promise<Driver> {
    let client = this.options.client;
    let ownsClient = false;
    if (!client) {
      const RedisClass = await loadRedisClass();
      const instance = new RedisClass(this.options.url ?? "redis://127.0.0.1:6379", {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        ...this.options.redisOptions,
      }) as Redis;
      instance.on("error", () => {
        // Suppress unhandled error event on Redis client
      });
      try {
        await instance.connect();
      } catch (err) {
        instance.disconnect();
        throw err;
      }
      client = instance;
      ownsClient = true;
    }
    return new RedisDriver(
      client,
      this.options.keyPrefix ?? "",
      ownsClient,
      this.options.allowFlushDbWithoutPrefix ?? false,
    );
  }
}

export class RedisDriver implements Driver {
  readonly provider: ProviderName = "redis";
  readonly capabilities: DriverCapabilities = {
    nativeTtl: true,
    jsonQuery: "none",
    managesOwnPool: true,
    supportsTransactions: true,
    supportsPrefixScan: true,
  };

  constructor(
    private readonly client: Redis,
    private readonly prefix: string,
    private readonly ownsClient: boolean = false,
    private readonly allowFlushDbWithoutPrefix: boolean = false,
  ) {}

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  private stripKey(fullKey: string): string {
    if (this.prefix && fullKey.startsWith(this.prefix)) {
      return fullKey.slice(this.prefix.length);
    }
    return fullKey;
  }

  async get(key: string): Promise<RawEntry | undefined> {
    const p = this.fullKey(key);
    const [raw, pttl] = await Promise.all([this.client.get(p), this.client.pttl(p)]);
    if (raw === null) return undefined;
    return {
      value: raw,
      expiresAt: pttl > 0 ? Date.now() + pttl : undefined,
    };
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const p = this.fullKey(key);
    if (typeof ttlMs === "number" && !Number.isNaN(ttlMs)) {
      if (ttlMs <= 0) {
        await this.client.del(p);
      } else {
        await this.client.set(p, value, "PX", Math.floor(ttlMs));
      }
    } else {
      await this.client.set(p, value);
    }
  }

  async delete(key: string): Promise<boolean> {
    const p = this.fullKey(key);
    const deleted = await this.client.del(p);
    return deleted > 0;
  }

  async has(key: string): Promise<boolean> {
    const p = this.fullKey(key);
    const count = await this.client.exists(p);
    return count > 0;
  }

  async clear(): Promise<void> {
    if (!this.prefix && this.allowFlushDbWithoutPrefix) {
      await this.client.flushdb();
    } else {
      await this.deleteByPrefix("");
    }
  }

  async getMany(keys: string[]): Promise<(RawEntry | undefined)[]> {
    if (keys.length === 0) return [];
    const fullKeys = keys.map((k) => this.fullKey(k));
    const CHUNK_SIZE = 500;
    const values: (string | null)[] = [];
    for (let i = 0; i < fullKeys.length; i += CHUNK_SIZE) {
      const chunk = fullKeys.slice(i, i + CHUNK_SIZE);
      const batchValues = await this.client.mget(chunk);
      values.push(...batchValues);
    }
    return values.map((val: string | null) => (val !== null ? { value: val } : undefined));
  }

  async setMany(entries: KVEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = this.client.pipeline();
    for (const entry of entries) {
      const p = this.fullKey(entry.key);
      if (typeof entry.ttlMs === "number" && !Number.isNaN(entry.ttlMs)) {
        if (entry.ttlMs <= 0) {
          pipeline.del(p);
        } else {
          pipeline.set(p, entry.value, "PX", Math.floor(entry.ttlMs));
        }
      } else {
        pipeline.set(p, entry.value);
      }
    }
    const results = await pipeline.exec();
    if (results) {
      for (const [err] of results) {
        if (err) throw err;
      }
    }
  }

  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const fullKeys = keys.map((k) => this.fullKey(k));
    const CHUNK_SIZE = 500;
    let deleted = 0;
    for (let i = 0; i < fullKeys.length; i += CHUNK_SIZE) {
      const chunk = fullKeys.slice(i, i + CHUNK_SIZE);
      deleted += await this.client.del(chunk);
    }
    return deleted;
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    const pattern = prefix !== undefined ? `${this.fullKey(prefix)}*` : `${this.prefix}*`;
    let cursor = "0";
    do {
      const [nextCursor, batch] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 250);
      cursor = nextCursor;
      if (batch.length > 0) {
        const values = await this.client.mget(batch);
        for (let i = 0; i < batch.length; i++) {
          const k = batch[i];
          const v = values[i];
          if (k !== undefined && v !== null && v !== undefined) {
            yield [this.stripKey(k), { value: v }];
          }
        }
      }
    } while (cursor !== "0");
  }

  async getByPrefix(prefix: string): Promise<KVEntry[]> {
    const pattern = `${this.fullKey(prefix)}*`;
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return [];
    const CHUNK_SIZE = 500;
    const result: KVEntry[] = [];
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE);
      const values = await this.client.mget(chunk);
      for (let j = 0; j < chunk.length; j++) {
        const k = chunk[j];
        const v = values[j];
        if (k !== undefined && v !== null && v !== undefined) {
          result.push({
            key: this.stripKey(k),
            value: v,
          });
        }
      }
    }
    return result;
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const pattern = `${this.fullKey(prefix)}*`;
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return 0;
    const CHUNK_SIZE = 500;
    let deleted = 0;
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE);
      deleted += await this.client.del(...chunk);
    }
    return deleted;
  }

  async find(
    where: QueryNode,
    options: FindOptions = {},
    keyPrefix?: string,
  ): Promise<KVEntry[]> {
    const pattern = keyPrefix ? `${this.fullKey(keyPrefix)}*` : `${this.prefix}*`;
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return [];
    const CHUNK_SIZE = 500;
    const candidates: Array<{ key: string; value: string; doc: unknown }> = [];
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE);
      const values = await this.client.mget(chunk);
      for (let j = 0; j < chunk.length; j++) {
        const k = chunk[j];
        const v = values[j];
        if (k !== undefined && v !== null && v !== undefined) {
          try {
            const doc = deserialize(v);
            candidates.push({
              key: this.stripKey(k),
              value: v,
              doc,
            });
          } catch {
            // If non-JSON value, skip
          }
        }
      }
    }

    const filtered = candidates.filter((item) => evaluateQuery(where, item.doc));
    const sorted = sortDocuments(
      filtered.map((item) => ({ ...item, value: item.doc })),
      options.sort,
    );

    let result = sorted;
    if (options.offset !== undefined) {
      result = result.slice(options.offset);
    }
    if (options.limit !== undefined) {
      result = result.slice(0, options.limit);
    }

    return result.map((item) => {
      const original = filtered.find((c) => c.key === item.key)!;
      return {
        key: original.key,
        value: original.value,
      };
    });
  }

  async update(key: string, mutate: UpdateMutator): Promise<void> {
    const p = this.fullKey(key);
    let expectedRaw: string | null = null;
    let expectedTtl: number = -1;

    // Initial read
    const [initVal, initPttl] = await Promise.all([this.client.get(p), this.client.pttl(p)]);
    expectedRaw = initVal;
    expectedTtl = initPttl;

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      let current: RawEntry | undefined;
      if (expectedRaw !== null) {
        current = {
          value: expectedRaw,
          expiresAt: expectedTtl > 0 ? Date.now() + expectedTtl : undefined,
        };
      }

      // Compute mutation in Node.js
      const next = mutate(current);

      const expectedArg = expectedRaw === null ? "__KVDB_NIL__" : expectedRaw;
      const ttlArg = next.ttlMs !== undefined ? Math.max(0, Math.floor(next.ttlMs)) : -1;

      const [success, actualVal, actualPttl] = (await this.client.eval(
        CAS_UPDATE_LUA,
        1,
        p,
        expectedArg,
        next.value,
        String(ttlArg),
      )) as [number, string, string];

      if (success === 1) {
        return;
      }

      // CAS conflict: update expected and retry immediately
      expectedRaw = actualVal === "__KVDB_NIL__" ? null : actualVal;
      expectedTtl = Number(actualPttl);
    }

    throw new KvdbConnectionError(
      `update("${key}") exceeded ${MAX_UPDATE_ATTEMPTS} attempts under write contention`,
    );
  }

  async ensureIndex(_jsonPath: string): Promise<void> {
    // Redis has no native secondary expression indexing; query evaluator handles searches in-memory.
  }

  async purgeExpired(): Promise<number> {
    // Redis cleans expired keys automatically.
    return 0;
  }

  raw(): Redis {
    return this.client;
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.quit().catch(() => {
        this.client.disconnect();
      });
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [nextCursor, batch] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 250);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  }
}
