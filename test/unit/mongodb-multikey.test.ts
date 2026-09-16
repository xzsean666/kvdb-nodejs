import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db, Collection, MongoClient } from "mongodb";
import { MongoDriver } from "../../src/drivers/mongodb/mongodb-driver.js";
import type { MultiKeySchema } from "../../src/core/table-schema.js";
import type { SchemaTableDriver } from "../../src/drivers/types.js";

describe("MongoDB Multi-Key Driver (TASK-019)", () => {
  let mockCollections: Map<string, any>;
  let createdIndexes: Array<{ collection: string; spec: any; options?: any }>;
  let mockDb: Db;
  let mockClient: MongoClient;

  beforeEach(() => {
    mockCollections = new Map();
    createdIndexes = [];

    const getOrCreateMockColl = (collName: string) => {
      if (mockCollections.has(collName)) return mockCollections.get(collName);

      const docs = new Map<any, any>();

      const mockColl = {
        name: collName,
        findOne: vi.fn(async (query: any) => {
          for (const doc of docs.values()) {
            let match = true;
            for (const [k, v] of Object.entries(query)) {
              if (doc[k] !== v) {
                match = false;
                break;
              }
            }
            if (match) return { ...doc };
          }
          return null;
        }),
        updateOne: vi.fn(async (filter: any, update: any, options?: any) => {
          const id = filter._id;
          let doc = docs.get(id);
          if (!doc) {
            if (options?.upsert) {
              doc = { _id: id, ...(update.$setOnInsert ?? {}) };
              docs.set(id, doc);
            } else {
              return { matchedCount: 0, modifiedCount: 0 };
            }
          }
          if (update.$set) {
            Object.assign(doc, update.$set);
          }
          return { matchedCount: 1, modifiedCount: 1, upsertedId: id };
        }),
        deleteOne: vi.fn(async (filter: any) => {
          const id = filter._id;
          const existed = docs.delete(id);
          return { deletedCount: existed ? 1 : 0 };
        }),
        deleteMany: vi.fn(async (_filter: any) => {
          const count = docs.size;
          docs.clear();
          return { deletedCount: count };
        }),
        createIndex: vi.fn(async (spec: any, options?: any) => {
          createdIndexes.push({ collection: collName, spec, options });
          return "idx_ok";
        }),
        find: vi.fn((filter: any) => {
          let results: any[] = [];
          for (const doc of docs.values()) {
            results.push({ ...doc });
          }
          return {
            sort: vi.fn().mockReturnThis(),
            skip: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            toArray: vi.fn(async () => results),
          };
        }),
      };

      mockCollections.set(collName, mockColl);
      return mockColl;
    };

    mockDb = {
      collection: vi.fn((name: string) => getOrCreateMockColl(name)),
    } as unknown as Db;

    mockClient = {
      close: vi.fn(async () => {}),
    } as unknown as MongoClient;
  });

  it("creates dynamic multikey collection with secondary & composite indexes", async () => {
    const driver = new MongoDriver(mockClient, mockDb, mockDb.collection("kvdb_kv"));

    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string", index: { unique: true } },
        gasUsed: { type: "number" },
        isSuccess: { type: "boolean", default: true },
        meta: { type: "json", nullable: true },
      },
      indexes: [
        { name: "block_hash_idx", keys: ["blockNumber", "hash"] },
      ],
    };

    const table = (await driver.openSchemaTable!("blocks", schema)) as SchemaTableDriver;
    expect(table).toBeDefined();

    // Check registry document
    const registry = mockCollections.get("kvdb_schema_registry");
    expect(registry).toBeDefined();
    expect(registry.updateOne).toHaveBeenCalled();

    // Check created indexes
    const hashIndex = createdIndexes.find((idx) => idx.spec.hash === 1);
    expect(hashIndex).toBeDefined();
    expect(hashIndex!.options?.unique).toBe(true);

    const compositeIndex = createdIndexes.find((idx) => idx.spec.blockNumber === 1 && idx.spec.hash === 1);
    expect(compositeIndex).toBeDefined();
    expect(compositeIndex!.options?.name).toBe("block_hash_idx");
  });

  it("stores multi-type secondary keys as top-level fields on setRecord", async () => {
    const driver = new MongoDriver(mockClient, mockDb, mockDb.collection("kvdb_kv"));

    const schema: MultiKeySchema = {
      primaryKey: { name: "txId", type: "string" },
      keys: {
        from: { type: "string", index: true },
        nonce: { type: "integer" },
      },
    };

    const table = (await driver.openSchemaTable!("txs", schema)) as SchemaTableDriver;

    await table.setRecord("0xabc", JSON.stringify({ amount: 100 }), {
      from: "0xuser1",
      nonce: 42,
    });

    const physicalColl = [...mockCollections.values()].find((c) => c.name.startsWith("kvdb_schema_txs_"));
    expect(physicalColl).toBeDefined();
    expect(physicalColl.updateOne).toHaveBeenCalledWith(
      { _id: "0xabc" },
      expect.objectContaining({
        $set: expect.objectContaining({
          _id: "0xabc",
          txId: "0xabc",
          from: "0xuser1",
          nonce: 42,
          value: JSON.stringify({ amount: 100 }),
        }),
      }),
      { upsert: true },
    );
  });

  it("retrieves records via getRecord and getRecordByKey", async () => {
    const driver = new MongoDriver(mockClient, mockDb, mockDb.collection("kvdb_kv"));

    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string", index: { unique: true } },
      },
    };

    const table = (await driver.openSchemaTable!("blocks", schema)) as SchemaTableDriver;

    await table.setRecord(100, JSON.stringify({ miner: "pool1" }), {
      hash: "0xbeef",
    });

    const byPk = await table.getRecord(100);
    expect(byPk).toBeDefined();
    expect(byPk!.key).toBe(100);
    expect(byPk!.columns.hash).toBe("0xbeef");

    const bySecondaryKey = await table.getRecordByKey!("hash", "0xbeef");
    expect(bySecondaryKey).toBeDefined();
    expect(bySecondaryKey!.key).toBe(100);
    expect(bySecondaryKey!.columns.hash).toBe("0xbeef");
  });

  it("dynamically adds key and creates index via addKey", async () => {
    const driver = new MongoDriver(mockClient, mockDb, mockDb.collection("kvdb_kv"));

    const schema: MultiKeySchema = {
      primaryKey: { name: "id", type: "string" },
      keys: {
        name: { type: "string" },
      },
    };

    const table = (await driver.openSchemaTable!("users", schema)) as SchemaTableDriver;
    createdIndexes = [];

    await table.addKey!("email", { type: "string", index: { unique: true } });

    const emailIndex = createdIndexes.find((idx) => idx.spec.email === 1);
    expect(emailIndex).toBeDefined();
    expect(emailIndex!.options?.unique).toBe(true);
    expect(table.schema.keys?.email).toBeDefined();
  });

  it("dynamically adds composite index via addIndex", async () => {
    const driver = new MongoDriver(mockClient, mockDb, mockDb.collection("kvdb_kv"));

    const schema: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: {
        tenantId: { type: "string" },
        createdAt: { type: "integer" },
      },
    };

    const table = (await driver.openSchemaTable!("orders", schema)) as SchemaTableDriver;
    createdIndexes = [];

    await table.addIndex!({
      name: "tenant_date_idx",
      keys: ["tenantId", "createdAt"],
    });

    const compositeIndex = createdIndexes.find((idx) => idx.spec.tenantId === 1 && idx.spec.createdAt === 1);
    expect(compositeIndex).toBeDefined();
    expect(compositeIndex!.options?.name).toBe("tenant_date_idx");
  });

  it("compiles column filters to top-level document fields", async () => {
    const { compileMongoFilter, compileMongoSort } = await import("../../src/drivers/mongodb/compiler.js");

    const colFilter = compileMongoFilter({
      kind: "cmp",
      op: "$eq",
      path: { sourceKind: "column", source: "tenantId", segments: [] },
      value: "t1",
    });
    expect(colFilter).toEqual({ tenantId: "t1" });

    const nestedColFilter = compileMongoFilter({
      kind: "cmp",
      op: "$gt",
      path: { sourceKind: "column", source: "meta", segments: [{ key: "score" }] },
      value: 80,
    });
    expect(nestedColFilter).toEqual({ "meta.score": { $gt: 80 } });

    const sort = compileMongoSort([
      { path: { sourceKind: "column", source: "createdAt", segments: [] }, direction: "desc" },
    ]);
    expect(sort).toEqual({ createdAt: -1 });
  });
});

