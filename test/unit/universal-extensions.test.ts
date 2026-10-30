import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  KVDB,
  KvdbLockError,
  parseCronExpression,
  getNextCronTime,
} from "../../src/index.js";

describe("Universal High-Value Developer Extensions (TASK-035)", () => {
  let db: KVDB;

  beforeEach(async () => {
    // In-memory SQLite mode: zero disk dependency, runs everywhere
    db = new KVDB({
      driver: "sqlite",
      url: ":memory:",
    });
    await db.connect();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("1. Atomic Increment & Decrement (Table.increment / decrement)", () => {
    it("atomically increments and decrements a scalar number", async () => {
      const table = db.table<number>("counters");

      // Key does not exist, starts from default (0) + 1
      const v1 = await table.increment("page_views", 1);
      expect(v1).toBe(1);

      const v2 = await table.increment("page_views", 5);
      expect(v2).toBe(6);

      const v3 = await table.decrement("page_views", 2);
      expect(v3).toBe(4);

      expect(await table.get("page_views")).toBe(4);
    });

    it("supports custom default value when key does not exist", async () => {
      const table = db.table<number>("points");
      const v1 = await table.increment("player:1", 10, { default: 100 });
      expect(v1).toBe(110);
    });

    it("atomically modifies nested JSON properties via path", async () => {
      interface UserDoc {
        name: string;
        stats: {
          views: number;
          likes: number;
        };
      }

      const table = db.table<UserDoc>("users");
      await table.set("user:1", {
        name: "Alice",
        stats: { views: 100, likes: 10 },
      });

      const newLikes = await table.increment("user:1", 1, { path: "stats.likes" });
      expect(newLikes).toBe(11);

      const newViews = await table.decrement("user:1", 20, { path: "stats.views" });
      expect(newViews).toBe(80);

      const updated = await table.get("user:1");
      expect(updated?.name).toBe("Alice");
      expect(updated?.stats.likes).toBe(11);
      expect(updated?.stats.views).toBe(80);
    });
  });

  describe("2. Distributed Lock & Mutex (withLock / acquireLock)", () => {
    it("successfully acquires and releases lock sequentially", async () => {
      const lock = await db.acquireLock("lock:resource:1", { ttlMs: 5000 });
      expect(lock).not.toBeNull();
      expect(lock?.key).toBe("lock:resource:1");
      expect(typeof lock?.token).toBe("string");

      const released = await lock!.release();
      expect(released).toBe(true);

      // Can immediately acquire again after release
      const lock2 = await db.acquireLock("lock:resource:1", { ttlMs: 5000 });
      expect(lock2).not.toBeNull();
      await lock2!.release();
    });

    it("blocks competing acquireLock until timeout when lock is held", async () => {
      const lock1 = await db.acquireLock("lock:exclusive", { ttlMs: 10_000 });
      expect(lock1).not.toBeNull();

      // Competing acquire with short waitTimeoutMs should fail (return null)
      const lock2 = await db.acquireLock("lock:exclusive", {
        ttlMs: 5000,
        waitTimeoutMs: 150,
        retryIntervalMs: 50,
      });
      expect(lock2).toBeNull();

      await lock1!.release();

      // After release, competing acquire succeeds
      const lock3 = await db.acquireLock("lock:exclusive", {
        ttlMs: 5000,
        waitTimeoutMs: 500,
      });
      expect(lock3).not.toBeNull();
      await lock3!.release();
    });

    it("executes critical section within withLock and releases automatically", async () => {
      let executed = false;
      const res = await db.withLock("lock:order:1001", async (handle) => {
        expect(handle.token).toBeTruthy();
        executed = true;
        return 42;
      });

      expect(executed).toBe(true);
      expect(res).toBe(42);

      // Lock should have been released automatically
      const lockAfter = await db.acquireLock("lock:order:1001", { waitTimeoutMs: 100 });
      expect(lockAfter).not.toBeNull();
      await lockAfter!.release();
    });

    it("throws KvdbLockError if withLock cannot acquire within timeout", async () => {
      const lock = await db.acquireLock("lock:busy", { ttlMs: 10_000 });
      expect(lock).not.toBeNull();

      await expect(
        db.withLock("lock:busy", async () => "ok", { waitTimeoutMs: 100, retryIntervalMs: 50 }),
      ).rejects.toThrow(KvdbLockError);

      await lock!.release();
    });
  });

  describe("3. Sliding Window Rate Limiter (RateLimiter)", () => {
    it("allows requests under the limit and blocks when exceeded", async () => {
      const limiter = db.rateLimiter({
        windowMs: 5000,
        limit: 3,
      });

      const r1 = await limiter.consume("ip:127.0.0.1", 1);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);
      expect(r1.current).toBe(1);

      const r2 = await limiter.consume("ip:127.0.0.1", 1);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);
      expect(r2.current).toBe(2);

      const r3 = await limiter.consume("ip:127.0.0.1", 1);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);
      expect(r3.current).toBe(3);

      // Exceeded limit!
      const r4 = await limiter.consume("ip:127.0.0.1", 1);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
      expect(r4.current).toBe(4);
    });

    it("checks rate limit without consuming tokens", async () => {
      const limiter = db.rateLimiter({
        windowMs: 5000,
        limit: 5,
      });

      await limiter.consume("user:42", 2);

      const check = await limiter.check("user:42");
      expect(check.allowed).toBe(true);
      expect(check.current).toBe(2);
      expect(check.remaining).toBe(3);

      // Current count did not increase from check()
      const checkAgain = await limiter.check("user:42");
      expect(checkAgain.current).toBe(2);
    });

    it("resets rate limit for a key", async () => {
      const limiter = db.rateLimiter({
        windowMs: 5000,
        limit: 2,
      });

      await limiter.consume("ip:reset", 2);
      expect((await limiter.consume("ip:reset", 1)).allowed).toBe(false);

      await limiter.reset("ip:reset");
      const fresh = await limiter.consume("ip:reset", 1);
      expect(fresh.allowed).toBe(true);
      expect(fresh.current).toBe(1);
    });
  });

  describe("4. Idempotency Execution Guard (db.idempotent)", () => {
    it("executes once and returns cached result on subsequent invocations", async () => {
      let callCount = 0;

      const run = async () => {
        return db.idempotent("order:charge:101", async () => {
          callCount++;
          return { charged: true, amount: 99 };
        });
      };

      const res1 = await run();
      const res2 = await run();
      const res3 = await run();

      expect(callCount).toBe(1);
      expect(res1).toEqual({ charged: true, amount: 99 });
      expect(res2).toEqual({ charged: true, amount: 99 });
      expect(res3).toEqual({ charged: true, amount: 99 });
    });

    it("allows retry after failure", async () => {
      let attempts = 0;

      const run = async () => {
        return db.idempotent("order:failing:202", async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error("Network error");
          }
          return "success";
        });
      };

      await expect(run()).rejects.toThrow("Network error");
      expect(attempts).toBe(1);

      // Second attempt succeeds
      const res = await run();
      expect(res).toBe("success");
      expect(attempts).toBe(2);
    });
  });

  describe("5. Cron Parser & Distributed Scheduling (Queue.schedule)", () => {
    it("correctly parses 5-field cron expressions and computes nextRunAt", () => {
      const parsed = parseCronExpression("*/15 * * * *");
      expect(parsed.minutes.has(0)).toBe(true);
      expect(parsed.minutes.has(15)).toBe(true);
      expect(parsed.minutes.has(30)).toBe(true);
      expect(parsed.minutes.has(45)).toBe(true);
      expect(parsed.minutes.has(10)).toBe(false);

      const now = new Date("2026-10-30T10:00:00.000Z").getTime();
      const next = getNextCronTime("0 12 * * *", now);
      const nextDate = new Date(next);
      expect(nextDate.getHours()).toBe(12);
      expect(nextDate.getMinutes()).toBe(0);
      expect(next > now).toBe(true);
    });

    it("schedules and lists recurring jobs on a queue", async () => {
      const queue = db.queue<{ task: string }>("scheduled_tasks");

      const sched = await queue.schedule("daily_cleanup", "0 0 * * *", { task: "clean" });
      expect(sched.name).toBe("daily_cleanup");
      expect(sched.queue).toBe("scheduled_tasks");
      expect(sched.nextRunAt).toBeGreaterThan(Date.now());

      const list = await queue.listScheduled();
      expect(list.length).toBe(1);
      expect(list[0]?.name).toBe("daily_cleanup");

      const removed = await queue.unschedule("daily_cleanup");
      expect(removed).toBe(true);

      const listAfter = await queue.listScheduled();
      expect(listAfter.length).toBe(0);
    });
  });

  describe("6. Keyv Standard Adapter (table.asKeyv)", () => {
    it("implements standard Keyv storage interface seamlessly", async () => {
      const table = db.table<string>("keyv_store");
      const keyv = table.asKeyv();

      await keyv.set("session:abc", "user_123", 5000);
      expect(await keyv.get("session:abc")).toBe("user_123");
      expect(await keyv.has?.("session:abc")).toBe(true);

      const deleted = await keyv.delete("session:abc");
      expect(deleted).toBe(true);
      expect(await keyv.get("session:abc")).toBeUndefined();
      expect(await keyv.has?.("session:abc")).toBe(false);

      await keyv.set("k1", "v1");
      await keyv.set("k2", "v2");
      await keyv.clear();
      expect(await keyv.get("k1")).toBeUndefined();
      expect(await keyv.get("k2")).toBeUndefined();
    });
  });
});
