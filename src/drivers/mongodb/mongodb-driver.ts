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
import type {
  Driver,
  DriverFactory,
  DriverCapabilities,
  ProviderName,
  UpdateMutator,
  SchemaTableDriver,
} from "../types.js";
import type { KVEntry, RawEntry } from "../../cache/types.js";
import type { QueryNode, FindOptions } from "../../query/ast.js";
import { compileMongoFilter, compileMongoSort } from "./compiler.js";
import { expiresAtFromTtl } from "../../core/expiry.js";
import { deserialize } from "../../core/serializer.js";
import { KvdbConfigError, KvdbConnectionError } from "../../core/errors.js";
import type {
  TableSchema,
  MultiKeySchema,
  KeyDefinition,
  TableIndexDefinition,
  MultiKeyIndexDefinition,
} from "../../core/table-schema.js";
import {
  normalizeTableSchema,
  validateMultiKeySchema,
  evolveSchemaAddKey,
  evolveSchemaAddIndex,
  schemasEqual,
} from "../../core/table-schema.js";

const PROVIDER: ProviderName = "mongodb";

/** Retry budget for the optimistic-concurrency update loop before giving up. */
const MAX_UPDATE_ATTEMPTS = 256;

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

interface SchemaDocument {
  _id: string | number;
  value: string;
  doc: unknown;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
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

export class MongoDriver implements Driver {
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

  async update(key: string, mutate: UpdateMutator): Promise<void> {
    // No multi-statement lock on standalone Mongo, so use optimistic
    // concurrency: read, compute, then write only if the stored value is still
    // what we read (compare-and-swap on `value`). A concurrent write changes
    // `value`, the CAS misses, and we retry against the new value — no lost
    // update. A brand-new/expired key has no prior value to guard, so it upserts
    // (last-write-wins for the rare concurrent-create case).
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const now = Date.now();
      const doc = await this.collection.findOne({ _id: key });
      let current: RawEntry | undefined;
      if (doc !== null) {
        const expiresAt = doc.expiresAt ?? undefined;
        if (expiresAt === undefined || expiresAt > now) {
          current = { value: doc.value, expiresAt };
        }
      }
      const next = mutate(current);
      const set = {
        value: next.value,
        doc: deserialize(next.value),
        expiresAt: expiresAtFromTtl(next.ttlMs, now) ?? null,
      };
      if (current === undefined) {
        await this.collection.updateOne({ _id: key }, { $set: set }, { upsert: true });
        return;
      }
      const result = await this.collection.updateOne(
        { _id: key, value: current.value },
        { $set: set },
      );
      if (result.matchedCount === 1) return;
      // Lost the race: the row changed under us. Loop and merge against the new value.
    }
    throw new KvdbConnectionError(
      `update("${key}") exceeded ${MAX_UPDATE_ATTEMPTS} attempts under write contention`,
    );
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

  async openSchemaTable<Columns extends Record<string, unknown>>(
    name: string,
    schema?: TableSchema<Columns> | MultiKeySchema<Columns>,
  ): Promise<SchemaTableDriver<unknown, Columns> | undefined> {
    const registry = this.db.collection<{ _id: string; schema_json: string }>("kvdb_schema_registry");
    const existing = await registry.findOne({ _id: name });
    if (existing && schema && !schemasEqual(JSON.parse(existing.schema_json) as TableSchema, schema)) {
      throw new KvdbConfigError(`Schema conflict for table ${name}`);
    }
    const resolved = (schema ?? (existing ? JSON.parse(existing.schema_json) : undefined)) as TableSchema<Columns> | undefined;
    if (!resolved) return undefined;
    validateMultiKeySchema(resolved);
    const norm = normalizeTableSchema(resolved);
    const collName = schemaCollectionName(name);
    const collection = this.db.collection<SchemaDocument>(collName);

    if (!existing) {
      await registry.updateOne(
        { _id: name },
        { $setOnInsert: { schema_json: JSON.stringify(resolved) } },
        { upsert: true },
      );

      for (const [column, definition] of Object.entries(norm.keys)) {
        if (definition.index) {
          const idxOpts = typeof definition.index === "object" ? definition.index : {};
          const idxName = idxOpts.name ?? `${collName}_${column}_idx`;
          await collection.createIndex(
            { [column]: 1 },
            {
              unique: Boolean(idxOpts.unique),
              name: idxName,
            },
          );
        }
      }

      for (const index of norm.indexes) {
        const idxName = index.name ?? `${collName}_${index.keys.join("_")}_idx`;
        const indexSpec = Object.fromEntries(index.keys.map((k) => [k, 1]));
        await collection.createIndex(
          indexSpec,
          {
            unique: Boolean(index.unique),
            name: idxName,
          },
        );
      }

      await collection.createIndex({ expiresAt: 1 }, { name: `${collName}_expiresAt_idx` });
    }

    return new MongoSchemaTable(this.db, collection, registry, collName, name, resolved);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class MongoSchemaTable<Columns extends Record<string, unknown>> implements SchemaTableDriver<unknown, Columns> {
  schema: TableSchema<Columns>;

  constructor(
    private readonly db: Db,
    private readonly collection: Collection<SchemaDocument>,
    private readonly registry: Collection<{ _id: string; schema_json: string }>,
    private readonly physicalName: string,
    private readonly logicalName: string,
    schema: TableSchema<Columns>,
  ) {
    this.schema = schema;
  }

  private get pkName(): string {
    return this.schema.primaryKey?.name ?? "key";
  }

  private get secondaryKeys(): Record<string, KeyDefinition> {
    return (this.schema.keys ?? this.schema.columns ?? {}) as Record<string, KeyDefinition>;
  }

  async setRecord(key: string | number, value: string, columns: Record<string, unknown>, ttlMs?: number): Promise<void> {
    const pk = this.pkName;
    const now = Date.now();
    const docToSet: Record<string, unknown> = {
      _id: key,
      value,
      doc: deserialize(value),
      expiresAt: expiresAtFromTtl(ttlMs, now) ?? null,
      updatedAt: now,
    };
    if (pk !== "_id") {
      docToSet[pk] = key;
    }

    for (const [name, def] of Object.entries(this.secondaryKeys)) {
      const val = columns[name];
      if (val === undefined) {
        docToSet[name] = def.default !== undefined ? def.default : null;
      } else {
        docToSet[name] = val;
      }
    }

    await this.collection.updateOne(
      { _id: key as any },
      {
        $set: docToSet,
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  async getRecord(key: string | number): Promise<{ key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined> {
    const doc = await this.collection.findOne({ _id: key as any });
    if (!doc) return undefined;
    const expiresAt = (doc.expiresAt as number | null) ?? undefined;
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      await this.delete(key);
      return undefined;
    }
    return {
      key: this.parsePk(doc._id),
      value: doc.value as string,
      columns: this.extractColumns(doc),
      expiresAt,
    };
  }

  async getRecordByKey(keyName: string, keyValue: unknown): Promise<{ key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined> {
    const query = (keyName === this.pkName || keyName === "_id")
      ? { _id: keyValue as any }
      : { [keyName]: keyValue };
    const doc = await this.collection.findOne(query as any);
    if (!doc) return undefined;
    const expiresAt = (doc.expiresAt as number | null) ?? undefined;
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      await this.delete(doc._id as unknown as string | number);
      return undefined;
    }
    return {
      key: this.parsePk(doc._id),
      value: doc.value as string,
      columns: this.extractColumns(doc),
      expiresAt,
    };
  }

  async delete(key: string | number): Promise<boolean> {
    return (await this.collection.deleteOne({ _id: key as any })).deletedCount > 0;
  }

  async clear(): Promise<void> {
    await this.collection.deleteMany({});
  }

  async find(where: QueryNode, options: FindOptions = {}): Promise<Array<{ key: string | number; value: string; columns: Record<string, unknown> }>> {
    const now = Date.now();
    const conditions: Record<string, unknown>[] = [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      compileMongoFilter(where),
    ];
    const filter = { $and: conditions };
    let cursor = this.collection.find(filter);
    if (options.sort && options.sort.length > 0) cursor = cursor.sort(compileMongoSort(options.sort));
    if (options.offset !== undefined) cursor = cursor.skip(options.offset);
    if (options.limit !== undefined) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs.map((doc) => ({
      key: this.parsePk(doc._id),
      value: doc.value as string,
      columns: this.extractColumns(doc),
    }));
  }

  async addKey(name: string, definition: KeyDefinition): Promise<void> {
    const evolved = evolveSchemaAddKey(this.schema, name, definition);
    if (schemasEqual(this.schema, evolved)) return;

    if (definition.index) {
      const idxOpts = typeof definition.index === "object" ? definition.index : {};
      const idxName = idxOpts.name ?? `${this.physicalName}_${name}_idx`;
      await this.collection.createIndex(
        { [name]: 1 },
        { unique: Boolean(idxOpts.unique), name: idxName },
      );
    }

    this.schema = evolved as unknown as TableSchema<Columns>;
    await this.registry.updateOne(
      { _id: this.logicalName },
      { $set: { schema_json: JSON.stringify(this.schema) } },
      { upsert: true },
    );
  }

  async addIndex(definition: TableIndexDefinition | MultiKeyIndexDefinition): Promise<void> {
    const evolved = evolveSchemaAddIndex(this.schema, definition);
    if (schemasEqual(this.schema, evolved)) return;

    const cols = definition.keys ?? definition.columns ?? [];
    const idxName = definition.name ?? `${this.physicalName}_${cols.join("_")}_idx`;
    const indexSpec = Object.fromEntries(cols.map((k) => [k, 1]));
    await this.collection.createIndex(
      indexSpec,
      { unique: Boolean(definition.unique), name: idxName },
    );

    this.schema = evolved as unknown as TableSchema<Columns>;
    await this.registry.updateOne(
      { _id: this.logicalName },
      { $set: { schema_json: JSON.stringify(this.schema) } },
      { upsert: true },
    );
  }

  private parsePk(val: unknown): string | number {
    const pkType = this.schema.primaryKey?.type ?? "string";
    return pkType === "integer" ? Number(val) : String(val);
  }

  private extractColumns(doc: Record<string, unknown>): Record<string, unknown> {
    const columns: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(this.secondaryKeys)) {
      const raw = doc[name];
      if (raw === undefined || raw === null) {
        columns[name] = null;
      } else if (definition.type === "integer" || definition.type === "number") {
        columns[name] = Number(raw);
      } else if (definition.type === "boolean") {
        columns[name] = Boolean(raw);
      } else {
        columns[name] = raw;
      }
    }
    return columns;
  }
}

function schemaCollectionName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, "_");
  return `kvdb_schema_${safe}_${simpleHash(name)}`;
}

function simpleHash(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

/** Escape a literal prefix for use inside a Mongo $regex anchor. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
