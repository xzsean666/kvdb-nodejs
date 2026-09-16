// 16 — Dynamic Multi-Key Tables: custom primary keys, secondary key indexing, and schema evolution.
//
// Run:  pnpm example examples/16-dynamic-multi-keys.ts
//
// Multi-Key tables map secondary keys to real physical columns (or Mongo top-level fields)
// with native B-Tree / hash indexes. Queries directly hit physical indexes rather than
// parsing JSON at query time. Tables can dynamically evolve by adding keys and composite indexes.

import { KVDB, type MultiKeySchema } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite" }); // in-memory SQLite

interface BlockData {
  miner: string;
  txCount: number;
}

type BlockKeys = {
  chainId: string;
  hash: string;
  gasUsed: number;
  status?: string;
  [key: string]: unknown;
};

// 1. Define schema: Integer Primary Key and secondary search keys with indexes
const schema: MultiKeySchema = {
  primaryKey: { name: "blockNumber", type: "integer" },
  keys: {
    chainId: { type: "string", index: true },
    hash: { type: "string", index: { unique: true } },
    gasUsed: { type: "number" },
  },
};

const blocks = db.table<BlockData, BlockKeys>("blocks", { schema });

console.log("▶ Writing initial block records with secondary keys...");
await blocks.set(1001, { miner: "0xpoolA", txCount: 42 }, {
  keys: {
    chainId: "ethereum",
    hash: "0xabc1",
    gasUsed: 21000,
  },
});

await blocks.set(1002, { miner: "0xpoolB", txCount: 15 }, {
  keys: {
    chainId: "ethereum",
    hash: "0xabc2",
    gasUsed: 45000,
  },
});

await blocks.set(1003, { miner: "0xpoolA", txCount: 99 }, {
  keys: {
    chainId: "polygon",
    hash: "0xabc3",
    gasUsed: 30000,
  },
});

// 2. Point lookup by Primary Key
console.log("\n▶ Point lookup by primary key (1001):");
const b1 = await blocks.get(1001);
console.log("Value:", b1);

const rec1 = await blocks.getRecord(1001);
console.log("Full Record:", { key: rec1?.key, keys: rec1?.columns, value: rec1?.value });

// 3. Fast O(1) point lookup by indexed secondary key
console.log("\n▶ Fast O(1) lookup by secondary key (hash = 0xabc2):");
const byHash = await blocks.getBy("hash", "0xabc2");
console.log("Found Block:", { blockNumber: byHash?.key, hash: byHash?.columns.hash, value: byHash?.value });

// 4. Dynamic Schema Evolution: add a new key and a composite index on the fly!
console.log("\n▶ Dynamically adding new key 'status' and composite index...");
await blocks.addKey("status", { type: "string", default: "finalized", index: true });
await blocks.addIndex({ name: "chain_status_idx", keys: ["chainId", "status"] });

// Write a new record using the dynamically added key
await blocks.set(1004, { miner: "0xpoolC", txCount: 1 }, {
  keys: {
    chainId: "ethereum",
    hash: "0xabc4",
    gasUsed: 12000,
    status: "pending",
  },
});

// Existing records automatically receive the default value:
const oldRec = await blocks.getRecord(1001);
console.log("Old block 1001 status (default):", oldRec?.columns.status); // "finalized"

const newRec = await blocks.getRecord(1004);
console.log("New block 1004 status (explicit):", newRec?.columns.status); // "pending"

// 5. Query targeting declared keys directly (automatically index-accelerated)
console.log("\n▶ Querying with physical key filter, sort, and pagination:");
const queryResults = await blocks.find({
  where: {
    chainId: "ethereum",
    gasUsed: { $gte: 20000 },
  },
  sort: [{ path: "gasUsed", direction: "desc" }],
  limit: 2,
});

console.log("Query Results (top Ethereum blocks by gasUsed >= 20000):");
for (const item of queryResults) {
  console.log(` - Block ${item.key}:`, item.value);
}

// 6. Find full physical records
const physicalResults = await blocks.findRecords({
  where: { status: "pending" },
});
console.log("\n▶ findRecords with status = 'pending':");
for (const rec of physicalResults) {
  console.log(` - Block ${rec.key} (hash: ${rec.columns.hash}, status: ${rec.columns.status})`);
}

await db.close();
console.log("\n✓ Dynamic Multi-Key example finished successfully!");
