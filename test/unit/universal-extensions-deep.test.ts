import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import {
  KVDB,
  KvdbLockError,
  KvdbRateLimitError,
} from "../../src/index.js";

describe("Deep Concurrency & Stress Tests for Universal Extensions (TASK-035)", () => {
  const diskDbPath = "./test-deep-extensions.db";
  let db: KVDB;

  beforeEach(async () => {
    if (existsSync(diskDbPath)) {
      try { unlinkSync(diskDbPath); } catch {}
    }
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
    await db.connect();
  });

  afterEach(async () => {
    await db.close().catch(() => {});
    if (existsSync(diskDbPath)) {
      try { unlinkSync(diskDbPath); } catch {}
    }
  });

  describe("1. Atomic Increment Concurrency & Deep Path Testing", () => {
    it("handles 50 concurrent increments without any lost updates", async () => {
      const table = db.table<number>("concurrent_counters", { autoBatch: false });

      // Run 50 concurrent increments on the exact same key
      const concurrency = 50;
      const tasks = Array.from({ length: concurrency }, () =>
        table.increment("hits", 1),
      );

      const results = await Promise.all(tasks);
      expect(results.length).toBe(concurrency);

      const finalValue = await table.get("hits");
      expect(finalValue).toBe(50);
    });

    it("handles concurrent mixed increments and decrements correctly", async () => {
      const table = db.table<number>("mixed_counters", { autoBatch: false });
      await table.set("balance", 100);

      // 30 increments of +2, 20 decrements of -1 => 100 + 60 - 20 = 140
      const incTasks = Array.from({ length: 30 }, () => table.increment("balance", 2));
      const decTasks = Array.from({ length: 20 }, () => table.decrement("balance", 1));

      await Promise.all([...incTasks, ...decTasks]);

      const finalValue = await table.get("balance");
      expect(finalValue).toBe(140);
    });

    it("creates deeply nested objects on non-existent keys", async () => {
      const table = db.table<any>("deep_objects", { autoBatch: false });

      const res1 = await table.increment("doc:1", 5, {
        path: "metrics.performance.latency.p99",
      });
      expect(res1).toBe(5);

      const res2 = await table.increment("doc:1", 3, {
        path: "metrics.performance.latency.p99",
      });
      expect(res2).toBe(8);

      const doc = await table.get("doc:1");
      expect(doc?.metrics?.performance?.latency?.p99).toBe(8);
    });
  });

  describe("2. Distributed Lock Cross-Instance & Concurrency Stress", () => {
    it("enforces mutual exclusion across two separate KVDB instances sharing a file", async () => {
      const dbA = new KVDB({ driver: "sqlite", url: diskDbPath });
      const dbB = new KVDB({ driver: "sqlite", url: diskDbPath });

      try {
        await Promise.all([dbA.connect(), dbB.connect()]);

        // Instance A acquires lock
        const lockA = await dbA.acquireLock("shared:migration", { ttlMs: 10_000 });
        expect(lockA).not.toBeNull();

        // Instance B attempts to acquire with non-blocking / short timeout -> must fail
        const lockB = await dbB.acquireLock("shared:migration", {
          ttlMs: 5000,
          waitTimeoutMs: 150,
          retryIntervalMs: 50,
        });
        expect(lockB).toBeNull();

        // Instance A extends lock
        const extended = await lockA!.extend(8000);
        expect(extended).toBe(true);

        // Instance A releases lock
        const released = await lockA!.release();
        expect(released).toBe(true);

        // Instance B can now acquire the lock
        const lockB2 = await dbB.acquireLock("shared:migration", {
          ttlMs: 5000,
          waitTimeoutMs: 500,
        });
        expect(lockB2).not.toBeNull();
        await lockB2!.release();
      } finally {
        await dbA.close().catch(() => {});
        await dbB.close().catch(() => {});
      }
    });

    it("recovers an abandoned/expired lock after lease TTL elapses", async () => {
      // Worker 1 acquires lock with short TTL of 200ms and abandons it (no heartbeat, no release)
      const lock1 = await db.acquireLock("crash:resource", {
        ttlMs: 200,
        autoHeartbeat: false,
      });
      expect(lock1).not.toBeNull();

      // Worker 2 tries to acquire with waitTimeoutMs: 600ms
      // Should wait out the 200ms expiry and successfully acquire!
      const startWait = Date.now();
      const lock2 = await db.acquireLock("crash:resource", {
        ttlMs: 5000,
        waitTimeoutMs: 1000,
        retryIntervalMs: 50,
      });

      expect(lock2).not.toBeNull();
      expect(Date.now() - startWait).toBeGreaterThanOrEqual(180);

      await lock2!.release();
    });

    it("concurrent callers contend for withLock and serialize correctly", async () => {
      let activeWorkers = 0;
      let maxConcurrentObserved = 0;
      const counterTable = db.table<number>("lock_test_count", { autoBatch: false });
      await counterTable.set("seq", 0);

      const workerFn = async (id: number) => {
        return db.withLock(
          "serialize:lock",
          async () => {
            activeWorkers++;
            maxConcurrentObserved = Math.max(maxConcurrentObserved, activeWorkers);

            // Simulate small critical section work
            await new Promise((r) => setTimeout(r, 20));
            await counterTable.increment("seq", 1);

            activeWorkers--;
            return id;
          },
          { ttlMs: 5000, waitTimeoutMs: 5000, retryIntervalMs: 20 },
        );
      };

      // 8 workers competing for the same lock
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => workerFn(i)),
      );

      expect(results.length).toBe(8);
      expect(maxConcurrentObserved).toBe(1); // Strict mutual exclusion!
      expect(await counterTable.get("seq")).toBe(8);
    });
  });

  describe("3. RateLimiter High-Concurrency Burst & Isolation", () => {
    it("handles burst requests and strictly respects the limit", async () => {
      const limiter = db.rateLimiter({ windowMs: 2000, limit: 5 });

      // Send 12 burst requests simultaneously for IP 1.2.3.4
      const requests = Array.from({ length: 12 }, () =>
        limiter.consume("client:1.2.3.4", 1),
      );

      const results = await Promise.all(requests);
      const allowedCount = results.filter((r) => r.allowed).length;
      const blockedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(5);
      expect(blockedCount).toBe(7);
    });

    it("guarantees independent rate limits across different keys", async () => {
      const limiter = db.rateLimiter({ windowMs: 2000, limit: 2 });

      // Exhaust user A
      await limiter.consume("user:A", 1);
      await limiter.consume("user:A", 1);
      const blockedA = await limiter.consume("user:A", 1);
      expect(blockedA.allowed).toBe(false);

      // User B should remain completely unblocked
      const allowedB1 = await limiter.consume("user:B", 1);
      const allowedB2 = await limiter.consume("user:B", 1);
      expect(allowedB1.allowed).toBe(true);
      expect(allowedB2.allowed).toBe(true);

      const blockedB = await limiter.consume("user:B", 1);
      expect(blockedB.allowed).toBe(false);
    });
  });

  describe("4. Idempotency High-Concurrency Collapsing & Fast Path", () => {
    it("merges 10 concurrent requests into exactly 1 underlying execution", async () => {
      let executionCount = 0;

      const heavyComputation = async () => {
        executionCount++;
        // Simulate remote payment gateway latency
        await new Promise((r) => setTimeout(r, 60));
        return { paymentId: "tx_98765", amount: 199.99 };
      };

      // 10 concurrent requests arrive in the exact same millisecond window
      const calls = Array.from({ length: 10 }, () =>
        db.idempotent("pay:order:2001", heavyComputation, {
          ttlMs: 60_000,
          timeoutMs: 5000,
          retryIntervalMs: 20,
        }),
      );

      const results = await Promise.all(calls);

      // Crucial verification: heavyComputation only executed ONCE!
      expect(executionCount).toBe(1);

      // All 10 callers received identical resolved payload
      for (const res of results) {
        expect(res).toEqual({ paymentId: "tx_98765", amount: 199.99 });
      }
    });

    it("serves subsequent requests instantly from the fast read path", async () => {
      let executions = 0;

      const fn = async () => {
        executions++;
        return "cached-value";
      };

      const res1 = await db.idempotent("fast:key", fn, { ttlMs: 10_000 });
      expect(res1).toBe("cached-value");
      expect(executions).toBe(1);

      // Immediate second call hits fast path
      const res2 = await db.idempotent("fast:key", fn, { ttlMs: 10_000 });
      expect(res2).toBe("cached-value");
      expect(executions).toBe(1);
    });
  });

  describe("5. Keyv Ecosystem Full Contract Coverage", () => {
    it("supports getMany, deleteMany, and stream iteration", async () => {
      const table = db.table<string>("full_keyv_table");
      const keyv = table.asKeyv();

      await keyv.set("item:1", "val1");
      await keyv.set("item:2", "val2");
      await keyv.set("item:3", "val3");

      // getMany
      const many = await keyv.getMany?.(["item:1", "item:2", "item:999"]);
      expect(many).toEqual(["val1", "val2", undefined]);

      // iterator
      const collected: [string, string][] = [];
      if (keyv.iterator) {
        for await (const entry of keyv.iterator()) {
          collected.push(entry as [string, string]);
        }
      }
      expect(collected.length).toBe(3);
      const keys = collected.map(([k]) => k).sort();
      expect(keys).toEqual(["item:1", "item:2", "item:3"]);

      // deleteMany
      const deletedCount = await keyv.deleteMany?.(["item:1", "item:3"]);
      expect(deletedCount).toBe(true);

      expect(await keyv.get("item:1")).toBeUndefined();
      expect(await keyv.get("item:2")).toBe("val2");
      expect(await keyv.get("item:3")).toBeUndefined();
    });
  });
});
