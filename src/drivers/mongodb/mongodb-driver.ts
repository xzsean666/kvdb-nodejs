// MongoDB driver — native mongodb driver backend (docs/ARCHITECTURE.md §3).
//
// Each entry is one document: { _id: <physical key>, value: <canonical JSON
// text>, doc: <parsed value>, expiresAt }. `value` is returned verbatim for
// exact round-trips; `doc` is the queryable copy that Mongo filters operate on.
//
// MongoDB pools connections internally (KD-6: managesOwnPool = true) — we do not
// add a pool. Expiry is enforced in queries for behavioral parity with the SQL
// backends (rather than a native TTL index, which would only purge lazily).
// mongodb is an optional peer dependency, imported lazily in connect().

import type { MongoClient, Db, Collection } from "mongodb";
import type { Driver, DriverFactory, DriverCapabilities, ProviderName } from "../types.js";
import type { KVEntry, RawEntry } from "../../cache/types.js";
import type { QueryNode, FindOptions } from "../../query/ast.js";
import { compileMongoFilter, compileMongoSort } from "./compiler.js";
import { expiresAtFromTtl } from "../../core/expiry.js";
import { deserialize } from "../../core/serializer.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";

const PROVIDER: ProviderName = "mongodb";

const CAPABILITIES: DriverCapabilities = {
  nativeTtl: false,
  jsonQuery: "mongo",
  managesOwnPool: true,
  supportsTransactions: true,
  supportsPrefixScan: true,
};

interface KvDocument {
  _id: string;
  value: string;
  doc: unknown;
  expiresAt: number | null;
}

export interface MongoDriverOptions {
  /** MongoDB connection string. */
  url: string;
  /** Database name. Defaults to the database in the connection string. */
  database?: string;
  /** Collection name. Defaults to "kvdb_kv". */
  collection?: string;
  /**
   * JSON value paths to index when connecting (e.g. ["profile.age"]).
   * Default: none — only the `_id` index Mongo creates automatically exists.
   */
  indexes?: string[];
}

export class MongoDriverFactory implements DriverFactory {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly options: MongoDriverOptions) {
    if (!options.url) throw new KvdbConfigError("MongoDB driver requires a `url`.");
  }

  async connect(): Promise<Driver> {
    let MongoClientCtor: typeof MongoClient;
    try {
      MongoClientCtor = (await import("mongodb")).MongoClient;
    } catch (cause) {
      throw new KvdbConnectionError(
        'The "mongodb" package is required for the MongoDB driver. Install it with `pnpm add mongodb`.',
        { cause },
      );
    }
    const client = new MongoClientCtor(this.options.url);
    await client.connect();
    const db = this.options.database ? client.db(this.options.database) : client.db();
    const collection = db.collection<KvDocument>(this.options.collection ?? "kvdb_kv");
    const driver = new MongoDriver(client, db, collection);
    for (const path of this.options.indexes ?? []) await driver.ensureIndex(path);
    return driver;
  }
}

class MongoDriver implements Driver {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;

  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly collection: Collection<KvDocument>,
  ) {}

  /** Filter fragment that excludes expired documents. */
  private liveFilter(now: number): Record<string, unknown> {
    return { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
  }

  async get(key: string): Promise<RawEntry | undefined> {
    const doc = await this.collection.findOne({ _id: key });
    if (doc === null) return undefined;
    const expiresAt = doc.expiresAt ?? undefined;
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      await this.delete(key);
      return undefined;
    }
    return { value: doc.value, expiresAt };
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    await this.collection.updateOne(
      { _id: key },
      {
        $set: {
          value,
          doc: deserialize(value),
          expiresAt: expiresAtFromTtl(ttlMs, Date.now()) ?? null,
        },
      },
      { upsert: true },
    );
  }

  async delete(key: string): Promise<boolean> {
    return (await this.collection.deleteOne({ _id: key })).deletedCount > 0;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async clear(): Promise<void> {
    await this.collection.deleteMany({});
  }

  async getMany(keys: string[]): Promise<(RawEntry | undefined)[]> {
    if (keys.length === 0) return [];
    const now = Date.now();
    const docs = await this.collection.find({ _id: { $in: keys } }).toArray();
    const byKey = new Map<string, RawEntry>();
    for (const doc of docs) {
      const expiresAt = doc.expiresAt ?? undefined;
      if (expiresAt !== undefined && expiresAt <= now) continue;
      byKey.set(doc._id, { value: doc.value, expiresAt });
    }
    return keys.map((key) => byKey.get(key));
  }

  async setMany(entries: KVEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = Date.now();
    await this.collection.bulkWrite(
      entries.map((entry) => ({
        updateOne: {
          filter: { _id: entry.key },
          update: {
            $set: {
              value: entry.value,
              doc: deserialize(entry.value),
              expiresAt: expiresAtFromTtl(entry.ttlMs, now) ?? null,
            },
          },
          upsert: true,
        },
      })),
    );
  }

  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return (await this.collection.deleteMany({ _id: { $in: keys } })).deletedCount;
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, RawEntry]> {
    const now = Date.now();
    const filter: Record<string, unknown> = { ...this.liveFilter(now) };
    if (prefix !== undefined) filter._id = { $regex: `^${escapeRegex(prefix)}` };
    for await (const doc of this.collection.find(filter)) {
      yield [doc._id, { value: doc.value, expiresAt: doc.expiresAt ?? undefined }];
    }
  }

  async getByPrefix(prefix: string): Promise<KVEntry[]> {
    const docs = await this.collection
      .find({ _id: { $regex: `^${escapeRegex(prefix)}` }, ...this.liveFilter(Date.now()) })
      .toArray();
    return docs.map((doc) => ({ key: doc._id, value: doc.value }));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    return (
      await this.collection.deleteMany({ _id: { $regex: `^${escapeRegex(prefix)}` } })
    ).deletedCount;
  }

  async find(where: QueryNode, options: FindOptions = {}, keyPrefix?: string): Promise<KVEntry[]> {
    const conditions: Record<string, unknown>[] = [
      this.liveFilter(Date.now()),
      compileMongoFilter(where),
    ];
    if (keyPrefix) conditions.push({ _id: { $regex: `^${escapeRegex(keyPrefix)}` } });
    const filter = { $and: conditions };
    let cursor = this.collection.find(filter, { projection: { value: 1 } });
    if (options.sort && options.sort.length > 0) cursor = cursor.sort(compileMongoSort(options.sort));
    if (options.offset !== undefined) cursor = cursor.skip(options.offset);
    if (options.limit !== undefined) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs.map((doc) => ({ key: doc._id, value: doc.value }));
  }

  async ensureIndex(jsonPath: string): Promise<void> {
    await this.collection.createIndex({ [`doc.${jsonPath}`]: 1 });
  }

  async purgeExpired(): Promise<number> {
    const result = await this.collection.deleteMany({
      expiresAt: { $ne: null, $lte: Date.now() },
    });
    return result.deletedCount;
  }

  raw(): Db {
    return this.db;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Escape a literal prefix for use inside a Mongo $regex anchor. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
