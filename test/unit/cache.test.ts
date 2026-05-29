import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cache } from "../../src/cache/cache.js";
import { MemoryStore } from "../../src/cache/stores/memory-store.js";

describe("MemoryStore", () => {
  it("stores and retrieves entries", () => {
    const store = new MemoryStore();
    store.set("a", '{"x":1}');
    expect(store.get("a")?.value).toBe('{"x":1}');
    expect(store.has("a")).toBe(true);
  });

  it("treats expired entries as missing", () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      store.set("a", "1", 1000);
      expect(store.has("a")).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(store.get("a")).toBeUndefined();
      expect(store.has("a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts least-recently-used beyond max", () => {
    const store = new MemoryStore({ max: 2 });
    store.set("a", "1");
    store.set("b", "2");
    store.get("a"); // touch a so b is the LRU
    store.set("c", "3");
    expect(store.has("b")).toBe(false);
    expect(store.has("a")).toBe(true);
    expect(store.has("c")).toBe(true);
  });

  it("iterates by prefix", async () => {
    const store = new MemoryStore();
    store.set("user:1", "a");
    store.set("user:2", "b");
    store.set("post:1", "c");
    const keys: string[] = [];
    for await (const [key] of store.iterator("user:")) keys.push(key);
    expect(keys.sort()).toEqual(["user:1", "user:2"]);
  });
});

describe("Cache", () => {
  it("round-trips structured values", async () => {
    const cache = new Cache({ driver: "memory" });
    await cache.set("k", { a: [1, 2], b: "x" });
    expect(await cache.get("k")).toEqual({ a: [1, 2], b: "x" });
  });

  it("returns undefined on miss", async () => {
    const cache = new Cache();
    expect(await cache.get("nope")).toBeUndefined();
  });

  it("set(undefined) deletes", async () => {
    const cache = new Cache();
    await cache.set("k", 1);
    await cache.set("k", undefined);
    expect(await cache.get("k")).toBeUndefined();
  });

  it("backfills higher tiers on a lower-tier hit", async () => {
    const top = new MemoryStore();
    const bottom = new MemoryStore();
    const cache = new Cache({ stores: [top, bottom] });
    // Seed only the bottom tier directly.
    bottom.set("k", '{"v":1}');
    expect(top.has("k")).toBe(false);
    const value = await cache.get<{ v: number }>("k");
    expect(value).toEqual({ v: 1 });
    expect(top.has("k")).toBe(true); // backfilled
  });

  describe("wrap", () => {
    it("memoizes the function result", async () => {
      const cache = new Cache();
      const fn = vi.fn(async () => ({ n: 42 }));
      expect(await cache.wrap("k", fn)).toEqual({ n: 42 });
      expect(await cache.wrap("k", fn)).toEqual({ n: 42 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("re-computes after expiry", async () => {
      vi.useFakeTimers();
      try {
        const cache = new Cache();
        let n = 0;
        const fn = vi.fn(async () => ++n);
        expect(await cache.wrap("k", fn, { ttlMs: 1000 })).toBe(1);
        vi.advanceTimersByTime(1001);
        expect(await cache.wrap("k", fn, { ttlMs: 1000 })).toBe(2);
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("serves stale and refreshes in the background (SWR)", async () => {
      const cache = new Cache();
      let n = 1;
      const fn = vi.fn(async () => n);
      // Prime with ttl 1000, refreshThreshold 5000 -> immediately within threshold.
      await cache.wrap("k", fn, { ttlMs: 1000, refreshThreshold: 5000 });
      n = 2;
      const stale = await cache.wrap("k", fn, { ttlMs: 1000, refreshThreshold: 5000 });
      expect(stale).toBe(1); // returns stale value immediately
      // Background refresh runs on the microtask/macrotask queue.
      await vi.waitFor(async () => {
        expect(await cache.get("k")).toBe(2);
      });
    });
  });
});
