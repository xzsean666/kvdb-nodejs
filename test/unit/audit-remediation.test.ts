import { describe, it, expect, vi } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import { MemoryStore } from "../../src/cache/stores/memory-store.js";
import type { Driver, DriverFactory } from "../../src/drivers/types.js";

describe("Production Audit Remediation Suite (TASK-033)", () => {
  it("P0: recovers gracefully when factory.connect() temporarily fails", async () => {
    let connectAttempts = 0;
    const mockDriver: Driver = {
      provider: "sqlite",
      capabilities: { nativeTtl: false, jsonQuery: "sqlite-json", managesOwnPool: false, supportsTransactions: true, supportsPrefixScan: true },
      get: vi.fn(async () => ({ value: '"hello"' })),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
      has: vi.fn(async () => true),
      clear: vi.fn(async () => {}),
      getByPrefix: vi.fn(async () => []),
      deleteByPrefix: vi.fn(async () => 0),
      find: vi.fn(async () => []),
      ensureIndex: vi.fn(async () => {}),
      purgeExpired: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
      raw: vi.fn(() => ({})),
    };

    const mockFactory: DriverFactory = {
      provider: "sqlite",
      capabilities: mockDriver.capabilities,
      connect: vi.fn(async () => {
        connectAttempts++;
        if (connectAttempts === 1) {
          throw new Error("Temporary network glitch");
        }
        return mockDriver;
      }),
    };

    const db = new KVDB({ driver: "sqlite" });
    // Inject mock factory
    (db as any).factory = mockFactory;

    const table = db.table("test");

    // First attempt should fail
    await expect(table.get("k1")).rejects.toThrow("Temporary network glitch");

    // Second attempt must NOT be locked in rejected state; it should retry and succeed!
    const val = await table.get("k1");
    expect(val).toBe("hello");
    expect(connectAttempts).toBe(2);

    await db.close();
  });

  it("P0: enforces strict multi-tenant tablePrefix isolation for schema tables and caches", async () => {
    const sharedCache = new Cache({ stores: [new MemoryStore()] });

    const tenantA = new KVDB({
      driver: "sqlite",
      url: ":memory:",
      tablePrefix: "tenantA_",
      cache: sharedCache,
    });

    const tenantB = new KVDB({
      driver: "sqlite",
      url: ":memory:",
      tablePrefix: "tenantB_",
      cache: sharedCache,
    });

    const schema = {
      primaryKey: { name: "id", type: "string" as const },
      columns: {
        email: { type: "string" as const, index: true },
      },
    };

    const usersA = tenantA.table<{ name: string }>("users", {
      schema,
      queryCache: true,
    });

    const usersB = tenantB.table<{ name: string }>("users", {
      schema,
      queryCache: true,
    });

    // 1. Point-write under tenantA
    await usersA.set("u1", { name: "Tenant A Admin" }, { columns: { email: "a@corp.com" } });

    // 2. Tenant B should NOT see Tenant A's record either from DB or Cache
    expect(await usersB.exists("u1")).toBe(false);
    expect(await usersB.get("u1")).toBeUndefined();

    // 3. Query cache under tenant A
    const foundA = await usersA.find({ columns: { email: "a@corp.com" } });
    expect(foundA).toHaveLength(1);
    expect(foundA[0]?.value).toEqual({ name: "Tenant A Admin" });

    // 4. Query cache under tenant B must NOT leak Tenant A's cached query result
    const foundB = await usersB.find({ columns: { email: "a@corp.com" } });
    expect(foundB).toHaveLength(0);

    await tenantA.close();
    await tenantB.close();
  });

  it("P1: closes shared and per-table caches when db.close() is called", async () => {
    const closeSpyA = vi.fn(async () => {});
    const closeSpyB = vi.fn(async () => {});

    const mockStoreA = new MemoryStore();
    (mockStoreA as any).close = closeSpyA;

    const mockStoreB = new MemoryStore();
    (mockStoreB as any).close = closeSpyB;

    const instanceCache = new Cache({ stores: [mockStoreA] });
    const tableCache = new Cache({ stores: [mockStoreB] });

    const db = new KVDB({
      driver: "sqlite",
      url: ":memory:",
      cache: instanceCache,
    });

    db.table("custom", { cache: tableCache });

    await db.close();

    expect(closeSpyA).toHaveBeenCalled();
    expect(closeSpyB).toHaveBeenCalled();
  });

  it("P1: Queue getStats() returns accurate counts with bounded query execution", async () => {
    const db = new KVDB({ driver: "sqlite", url: ":memory:" });
    const q = db.queue<{ title: string }>("audit-stats-test");

    await q.push({ title: "Job 1" });
    await q.push({ title: "Job 2" });
    await q.push({ title: "Job 3" }, { delayMs: 60_000 });

    const stats = await q.getStats();
    expect(stats.waiting).toBe(2);
    expect(stats.delayed).toBe(1);
    expect(stats.active).toBe(0);
    expect(stats.total).toBe(3);

    await db.close();
  });
});
