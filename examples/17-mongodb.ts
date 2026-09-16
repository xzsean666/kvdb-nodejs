// 17 — MongoDB backend (native mongodb driver).
//
// Run:  MONGO_URL=mongodb://localhost:27017/test pnpm example examples/17-mongodb.ts
//   or: put MONGO_URL in .env.test at the repo root.
//
// MongoDB uses its native connection pool (KD-6: managesOwnPool = true).
// Documents are stored with _id as the physical key, and query ASTs compile
// directly to native MongoDB filter/sort expressions. Multi-key schemas map
// secondary keys to real top-level document fields with native B-Tree indexes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { KVDB, type MultiKeySchema } from "kvdb-sdk";

function mongoUrl(): string | undefined {
  if (process.env.MONGO_URL) return process.env.MONGO_URL;
  try {
    const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env.test");
    const line = readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("MONGO_URL="));
    return line?.slice("MONGO_URL=".length).trim();
  } catch {
    return undefined;
  }
}

const url = mongoUrl();
if (!url) {
  console.log("Set MONGO_URL (or .env.test) to run this example. Skipping.");
  process.exit(0);
}

const db = new KVDB({
  driver: "mongodb",
  url,
  table: "example_kv", // collection name
});

interface UserProfile {
  name: string;
  email: string;
  age: number;
  tags: string[];
}

type UserKeys = {
  tier: string;
  loginCount: number;
};

// Define multi-key schema for MongoDB
const schema: MultiKeySchema = {
  primaryKey: { name: "userId", type: "string" },
  keys: {
    tier: { type: "string", index: true },
    loginCount: { type: "number" },
  },
};

const users = db.table<UserProfile, UserKeys>("users", { schema });

await users.clear();

console.log("▶ Inserting records into MongoDB...");
await users.set("u_101", { name: "Alice", email: "alice@example.com", age: 28, tags: ["web3", "ai"] }, {
  keys: { tier: "gold", loginCount: 42 },
});
await users.set("u_102", { name: "Bob", email: "bob@example.com", age: 34, tags: ["cloud"] }, {
  keys: { tier: "silver", loginCount: 15 },
});
await users.set("u_103", { name: "Carol", email: "carol@example.com", age: 22, tags: ["design", "web3"] }, {
  keys: { tier: "gold", loginCount: 88 },
});

// 1. Point lookups
console.log("\n▶ Point lookup by primary key:");
const alice = await users.get("u_101");
console.log("Alice:", alice);

const aliceRecord = await users.getRecord("u_101");
console.log("Alice Record (with physical columns):", aliceRecord);

// 2. Fast point lookup by indexed secondary key
console.log("\n▶ Point lookup by secondary key (tier):");
const firstGold = await users.getBy("tier", "gold");
console.log("First Gold user found:", firstGold?.key, firstGold?.value.name);

// 3. Native Mongo JSON queries (combining payload fields and physical keys)
console.log("\n▶ Querying MongoDB with filter, sort, and limit:");
const goldWeb3Users = await users.find({
  where: {
    tier: "gold",
    age: { $gte: 25 },
  },
  sort: [{ path: "loginCount", direction: "desc" }],
});

console.log("Matched users:");
for (const u of goldWeb3Users) {
  console.log(` - ${u.key}: ${u.value.name} (age: ${u.value.age})`);
}

// 4. Atomic Partial Update in MongoDB
console.log("\n▶ Atomic partial update in MongoDB:");
const updatedAlice = await users.update("u_101", { age: 29 });
console.log("Alice updated age:", updatedAlice.age);

// 5. Access raw native MongoClient / Db handle
const rawMongo = (await db.raw()) as import("mongodb").Db;
const collections = await rawMongo.listCollections().toArray();
console.log("\n▶ Native MongoDB collections:", collections.map((c) => c.name));

await db.close();
console.log("\n✓ MongoDB example finished successfully!");
