import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import type { MultiKeySchema } from "../../src/core/table-schema.js";

interface BlockData {
  txCount: number;
  miner: string;
}

type BlockKeys = {
  chainId: string;
  hash: string;
  blockNumber: number;
  isMainnet: boolean;
  [key: string]: unknown;
};

describe("Table Multi-Key API (TASK-020)", () => {
  let db: KVDB;

  beforeEach(async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
    await db.connect();
  });

  afterEach(async () => {
    await db.close();
  });

  it("supports writing, primary key lookup, and full record retrieval", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        chainId: { type: "string", index: true },
        hash: { type: "string", index: { unique: true } },
        isMainnet: { type: "boolean", default: true },
      },
    };

    const table = db.table<BlockData, BlockKeys>("blocks", { schema });

    // Write using options.keys
    await table.set(1001, { txCount: 42, miner: "0xpool" }, {
      keys: {
        chainId: "ethereum",
        hash: "0xabc1",
        isMainnet: true,
      },
    });

    await table.set(1002, { txCount: 88, miner: "0xpool" }, {
      keys: {
        chainId: "ethereum",
        hash: "0xabc2",
      },
    });

    // 1. Point read value by primary key
    const val = await table.get(1001);
    expect(val).toEqual({ txCount: 42, miner: "0xpool" });

    // 2. Full record read by primary key
    const rec = await table.getRecord(1001);
    expect(rec).toBeDefined();
    expect(rec!.key).toBe(1001);
    expect(rec!.columns.chainId).toBe("ethereum");
    expect(rec!.columns.hash).toBe("0xabc1");
    expect(rec!.columns.isMainnet).toBe(true);
    expect(rec!.keys?.chainId).toBe("ethereum");
    expect(rec!.value).toEqual({ txCount: 42, miner: "0xpool" });

    // Check default applied
    const rec2 = await table.getRecord(1002);
    expect(rec2?.columns.isMainnet).toBe(true);
  });

  it("supports O(1) point lookup via getBy on secondary key", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string", index: { unique: true } },
      },
    };

    const table = db.table<BlockData, BlockKeys>("blocks_unique", { schema });

    await table.set(500, { txCount: 10, miner: "minerA" }, {
      keys: { hash: "0xbeef" },
    });

    const found = await table.getBy("hash", "0xbeef");
    expect(found).toBeDefined();
    expect(found!.key).toBe(500);
    expect(found!.columns.hash).toBe("0xbeef");
    expect(found!.value).toEqual({ txCount: 10, miner: "minerA" });

    const notFound = await table.getBy("hash", "0xnone");
    expect(notFound).toBeUndefined();
  });

  it("automatically routes find queries directly to declared physical key indexes", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        chainId: { type: "string", index: true },
        hash: { type: "string" },
      },
    };

    const table = db.table<BlockData, BlockKeys>("chain_events", { schema });

    await table.set(100, { txCount: 5, miner: "m1" }, { keys: { chainId: "eth", hash: "0x1" } });
    await table.set(200, { txCount: 15, miner: "m2" }, { keys: { chainId: "eth", hash: "0x2" } });
    await table.set(300, { txCount: 25, miner: "m3" }, { keys: { chainId: "polygon", hash: "0x3" } });
    await table.set(400, { txCount: 35, miner: "m4" }, { keys: { chainId: "eth", hash: "0x4" } });

    // Query targeting declared physical keys: chainId and blockNumber
    const results = await table.find({
      where: {
        chainId: "eth",
        blockNumber: { $gte: 200 },
      },
      sort: [{ path: "blockNumber", direction: "desc" }],
      limit: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.key).toBe("400");
    expect(results[0]?.value.txCount).toBe(35);
    expect(results[1]?.key).toBe("200");
    expect(results[1]?.value.txCount).toBe(15);
  });

  it("supports findRecords returning full physical records", async () => {
    const schema: MultiKeySchema<{ tag: string }> = {
      primaryKey: { name: "id", type: "integer" },
      keys: {
        tag: { type: "string" },
      },
    };

    const table = db.table<{ title: string }, { tag: string }>("articles", { schema });

    await table.set(1, { title: "TypeScript 5.8" }, { keys: { tag: "tech" } });
    await table.set(2, { title: "Cooking 101" }, { keys: { tag: "food" } });

    const records = await table.findRecords({
      where: { tag: "tech" },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.key).toBe(1);
    expect(records[0]?.columns.tag).toBe("tech");
    expect(records[0]?.value.title).toBe("TypeScript 5.8");
  });

  it("keeps standard non-schema KV tables completely backward compatible", async () => {
    const table = db.table<{ count: number }>("standard_kv");

    await table.set("counter", { count: 1 });
    const val = await table.get("counter");
    expect(val).toEqual({ count: 1 });

    const exists = await table.exists("counter");
    expect(exists).toBe(true);

    const deleted = await table.delete("counter");
    expect(deleted).toBe(true);
    expect(await table.get("counter")).toBeUndefined();
  });
});
