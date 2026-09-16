import { describe, it, expect, vi } from "vitest";
import {
  evolveSchemaAddKey,
  evolveSchemaAddIndex,
  type MultiKeySchema,
  type TableSchema,
  type KeyDefinition,
} from "../../src/core/table-schema.js";

import { KvdbSchemaError, KvdbError } from "../../src/core/errors.js";
import { Table } from "../../src/core/table.js";
import { KVDB } from "../../src/core/kvdb.js";
import { HookRuntime } from "../../src/plugins/runtime.js";
import type { Driver, SchemaTableDriver } from "../../src/drivers/types.js";

describe("Schema Evolution: evolveSchemaAddKey & evolveSchemaAddIndex", () => {
  const baseSchema: MultiKeySchema = {
    primaryKey: { name: "id", type: "integer" },
    keys: {
      status: { type: "string", index: true },
    },
    version: 1,
  };

  it("adds a new key with index and increments version", () => {
    const evolved = evolveSchemaAddKey(baseSchema, "priority", {
      type: "integer",
      index: { unique: true },
    });

    expect(evolved.keys.priority).toBeDefined();
    expect(evolved.keys.priority!.type).toBe("integer");
    expect(evolved.version).toBe(2);

    expect(evolved.indexes.some((idx) => idx.keys.includes("priority"))).toBe(true);
  });

  it("is idempotent when adding a key with identical definition", () => {
    const first = evolveSchemaAddKey(baseSchema, "score", { type: "number", nullable: true });
    expect(first.version).toBe(2);

    const second = evolveSchemaAddKey(first, "score", { type: "number", nullable: true });
    expect(second.version).toBe(2);
    expect(second).toEqual(first);
  });

  it("throws KvdbSchemaError when adding a key that exists with different definition", () => {
    expect(() =>
      evolveSchemaAddKey(baseSchema, "status", { type: "integer" }),
    ).toThrow(KvdbSchemaError);
  });

  it("rejects reserved word or primary key collision", () => {
    expect(() =>
      evolveSchemaAddKey(baseSchema, "value", { type: "string" }),
    ).toThrow(KvdbSchemaError);

    expect(() =>
      evolveSchemaAddKey(baseSchema, "id", { type: "integer" }),
    ).toThrow(KvdbSchemaError);
  });

  it("adds a compound index and increments version", () => {
    const withKey = evolveSchemaAddKey(baseSchema, "createdAt", { type: "number" });
    const withIndex = evolveSchemaAddIndex(withKey, {
      name: "status_created_idx",
      keys: ["status", "createdAt"],
    });

    expect(withIndex.version).toBe(3);
    expect(withIndex.indexes.some((idx) => idx.name === "status_created_idx")).toBe(true);
  });

  it("is idempotent when adding the same compound index", () => {
    const withIndex1 = evolveSchemaAddIndex(baseSchema, {
      keys: ["status", "id"],
    });
    expect(withIndex1.version).toBe(2);

    const withIndex2 = evolveSchemaAddIndex(withIndex1, {
      keys: ["status", "id"],
    });
    expect(withIndex2.version).toBe(2);
  });

  it("rejects compound index referencing unknown keys", () => {
    expect(() =>
      evolveSchemaAddIndex(baseSchema, { keys: ["status", "nonExistentKey"] }),
    ).toThrow(KvdbSchemaError);
  });
});

describe("Table API: addKey & addIndex", () => {
  it("throws UNSUPPORTED when called on a non-schema table", async () => {
    const mockDriver = {
      provider: "sqlite",
      capabilities: {
        nativeTtl: false,
        jsonQuery: "sqlite-json",
        managesOwnPool: false,
        supportsTransactions: true,
        supportsPrefixScan: true,
      },
    } as unknown as Driver;

    const table = new Table({
      getDriver: async () => mockDriver,
      scope: { tablePrefix: "", namespace: "plain" },
      hooks: new HookRuntime(),
    });

    await expect(
      table.addKey("foo", { type: "string" }),
    ).rejects.toThrow(KvdbError);

    await expect(
      table.addIndex({ keys: ["foo"] }),
    ).rejects.toThrow(KvdbError);
  });

  it("delegates addKey and addIndex to SchemaTableDriver", async () => {
    let currentSchema: TableSchema = {
      primaryKey: { name: "id", type: "string" },
      columns: {},
      keys: {},
      indexes: [],
      version: 1,
    };

    const mockSchemaDriver: SchemaTableDriver = {
      get schema() {
        return currentSchema;
      },
      setRecord: vi.fn(),
      getRecord: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      find: vi.fn(),
      addKey: vi.fn(async (name: string, def: KeyDefinition) => {
        currentSchema = {
          ...currentSchema,
          keys: { ...currentSchema.keys, [name]: def },
          columns: { ...currentSchema.columns, [name]: def },
          version: (currentSchema.version ?? 1) + 1,
        };
      }),
      addIndex: vi.fn(async (index) => {
        currentSchema = {
          ...currentSchema,
          indexes: [...(currentSchema.indexes ?? []), { ...index, columns: index.columns ?? index.keys ?? [] }],
          version: (currentSchema.version ?? 1) + 1,
        };
      }),

    };

    const mockDriver = {
      provider: "sqlite",
      capabilities: {
        nativeTtl: false,
        jsonQuery: "sqlite-json",
        managesOwnPool: false,
        supportsTransactions: true,
        supportsPrefixScan: true,
      },
      openSchemaTable: vi.fn(async () => mockSchemaDriver),
    } as unknown as Driver;

    const table = new Table({
      getDriver: async () => mockDriver,
      scope: { tablePrefix: "", namespace: "schemaTable" },
      schemaName: "schemaTable",
      schema: currentSchema,
      hooks: new HookRuntime(),
    });

    await table.addKey("status", { type: "string", index: true });
    expect(mockSchemaDriver.addKey).toHaveBeenCalledWith("status", { type: "string", index: true });

    await table.addIndex({ name: "status_idx", keys: ["status"] });
    expect(mockSchemaDriver.addIndex).toHaveBeenCalled();
  });
});

describe("KVDB: alterTable", () => {
  it("batch adds keys and indexes via db.alterTable", async () => {
    const db = new KVDB({ driver: "sqlite" });
    const alterSpy = vi.fn();

    // Create schema table
    const table = db.table("users", {
      schema: {
        columns: { name: { type: "string" } },
      },
    });

    vi.spyOn(table, "addKey").mockImplementation(async (name, def) => {
      alterSpy("addKey", name, def);
    });
    vi.spyOn(table, "addIndex").mockImplementation(async (idx) => {
      alterSpy("addIndex", idx);
    });
    vi.spyOn(db, "table").mockReturnValue(table as any);


    await db.alterTable("users", {
      addKeys: {
        email: { type: "string", index: { unique: true } },
        age: { type: "integer" },
      },
      addIndexes: [
        { name: "age_idx", keys: ["age"] },
      ],
    });

    expect(alterSpy).toHaveBeenCalledWith("addKey", "email", expect.objectContaining({ type: "string" }));
    expect(alterSpy).toHaveBeenCalledWith("addKey", "age", expect.objectContaining({ type: "integer" }));
    expect(alterSpy).toHaveBeenCalledWith("addIndex", expect.objectContaining({ name: "age_idx" }));

    await db.close();
  });
});
