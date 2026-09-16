// 19 — Zero-Downtime Schema Evolution & Migrations.
//
// Run:  pnpm example examples/19-schema-evolution-migrations.ts
//
// In traditional SQL databases, altering tables and creating indexes on non-empty
// production tables requires manual migrations, maintenance windows, or complex tooling.
//
// KVDB SDK provides Zero-Downtime Schema Evolution:
// 1. Add new secondary keys (columns) on the fly via `table.addKey()`
// 2. Add composite indexes via `table.addIndex()`
// 3. Batch alter tables via `db.alterTable()`
// 4. Default values automatically backfill for pre-existing rows without rewrite
// 5. Complete idempotency: safe to run repeatedly on startup without crashing

import { KVDB, type MultiKeySchema } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite" });

interface MemberData {
  displayName: string;
  avatarUrl?: string;
}

type MemberColumns = {
  email: string;
  plan?: string;
  isVerified?: boolean;
  score?: number;
  [key: string]: unknown;
};

// =========================================================================
// Phase 1: Deploy Version 1 of Application
// =========================================================================
console.log("=== Phase 1: Application v1 ===");

const schemaV1: MultiKeySchema = {
  primaryKey: { name: "memberId", type: "string" },
  keys: {
    email: { type: "string", index: { unique: true } },
  },
};

const members = db.table<MemberData, MemberColumns>("members", { schema: schemaV1 });

// Insert initial v1 members
await members.set("m_001", { displayName: "Alice" }, {
  keys: { email: "alice@acme.com" },
});
await members.set("m_002", { displayName: "Bob" }, {
  keys: { email: "bob@acme.com" },
});

console.log("Pre-existing v1 member record:");
const v1Record = await members.getRecord("m_001");
console.log("m_001 in v1:", { key: v1Record?.key, email: v1Record?.columns.email });

// =========================================================================
// Phase 2: Deploy Version 2 (Zero-Downtime Evolution on Active Table)
// =========================================================================
console.log("\n=== Phase 2: Application v2 (Live Schema Evolution) ===");

// 1. Dynamically add secondary key 'plan' with default 'free' and an index
console.log("Adding 'plan' column (string, default: 'free', index: true)...");
await members.addKey("plan", {
  type: "string",
  default: "free",
  index: true,
});

// 2. Dynamically add secondary key 'isVerified' with default false
console.log("Adding 'isVerified' column (boolean, default: false)...");
await members.addKey("isVerified", {
  type: "boolean",
  default: false,
});

// 3. Dynamically add a composite index on [plan, isVerified]
console.log("Adding composite index on [plan, isVerified]...");
await members.addIndex({
  name: "plan_verified_idx",
  keys: ["plan", "isVerified"],
});

// 4. Verify existing records now transparently have the new columns with default values!
const oldMemberEvolved = await members.getRecord("m_001");
console.log("Pre-existing member m_001 now has default values automatically:");
console.log(" - plan:", oldMemberEvolved?.columns.plan); // "free"
console.log(" - isVerified:", oldMemberEvolved?.columns.isVerified); // false

// =========================================================================
// Phase 3: Write New v2 Data & Query Across Both Eras
// =========================================================================
console.log("\n=== Phase 3: Writing v2 Records & Querying ===");

// Insert a new member using new v2 physical keys
await members.set("m_003", { displayName: "Carol (Pro)" }, {
  keys: {
    email: "carol@acme.com",
    plan: "enterprise",
    isVerified: true,
  },
});

// Query all members with plan = 'free' (includes old records that defaulted to 'free'!)
const freeMembers = await members.findRecords({
  where: { plan: "free" },
});

console.log(`Found ${freeMembers.length} free member(s):`);
for (const m of freeMembers) {
  console.log(` - ${m.key}: ${m.value.displayName} (plan: ${m.columns.plan})`);
}

// Query enterprise members
const enterpriseMembers = await members.findRecords({
  where: { plan: "enterprise" },
});
console.log(`Found ${enterpriseMembers.length} enterprise member(s):`);
for (const m of enterpriseMembers) {
  console.log(` - ${m.key}: ${m.value.displayName} (verified: ${m.columns.isVerified})`);
}

// =========================================================================
// Phase 4: Idempotency Demonstration (Safe to re-run on every startup)
// =========================================================================
console.log("\n=== Phase 4: Idempotency Check ===");
console.log("Re-executing addKey and addIndex with identical definitions...");
await members.addKey("plan", { type: "string", default: "free", index: true });
await members.addIndex({ name: "plan_verified_idx", keys: ["plan", "isVerified"] });
console.log("✓ Re-running migrations completed safely with zero errors or duplicates!");

// Batch alter via db.alterTable
console.log("\nUsing db.alterTable() for batch migration:");
await db.alterTable("members", {
  addKeys: {
    score: { type: "number", default: 0 },
  },
});
const memberWithScore = await members.getRecord("m_003");
console.log("Member m_003 after batch alter score:", memberWithScore?.columns.score);

await db.close();
console.log("\n✓ Schema Evolution & Migrations example finished successfully!");
