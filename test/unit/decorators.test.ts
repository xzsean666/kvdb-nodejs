import { describe, it, expect, beforeEach, vi } from "vitest";
import { Cache } from "../../src/cache/cache.js";
import {
  Cacheable,
  CacheClear,
  setDefaultCache,
  clearDefaultCache,
} from "../../src/decorators/cacheable.js";
import { defaultKey } from "../../src/decorators/cache-key.js";

describe("@Cacheable / @CacheClear", () => {
  let cache: Cache;

  beforeEach(() => {
    cache = new Cache({ driver: "memory" });
    setDefaultCache(cache);
  });

  it("memoizes method results by arguments", async () => {
    const calls = vi.fn();
    class Service {
      @Cacheable()
      async getUser(id: string) {
        calls();
        return { id, fetchedAt: calls.mock.calls.length };
      }
    }
    const service = new Service();
    const first = await service.getUser("u1");
    const second = await service.getUser("u1");
    expect(second).toEqual(first); // served from cache
    expect(calls).toHaveBeenCalledTimes(1);

    await service.getUser("u2"); // different args -> miss
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("supports a custom cacheKey builder", async () => {
    class Service {
      @Cacheable({ cacheKey: (args) => `user:${args[0]}` })
      async fetch(id: string) {
        return id.toUpperCase();
      }
    }
    await new Service().fetch("abc");
    expect(await cache.get("user:abc")).toBe("ABC");
  });

  it("@CacheClear evicts a key after the method runs", async () => {
    class Service {
      @Cacheable({ cacheKey: (args) => `user:${args[0]}` })
      async get(id: string) {
        return id;
      }

      @CacheClear({ cacheKey: (args) => `user:${args[0]}` })
      async update(id: string) {
        return `updated ${id}`;
      }
    }
    const service = new Service();
    await service.get("x");
    expect(await cache.get("user:x")).toBe("x");
    await service.update("x");
    expect(await cache.get("user:x")).toBeUndefined();
  });

  it("throws when no cache is configured", async () => {
    clearDefaultCache();
    class Service {
      @Cacheable()
      async get() {
        return 1;
      }
    }
    await expect(new Service().get()).rejects.toThrow(/No cache/);
  });
});

describe("defaultKey", () => {
  it("is stable across argument key order", () => {
    expect(defaultKey("S", "m", [{ a: 1, b: 2 }])).toBe(defaultKey("S", "m", [{ b: 2, a: 1 }]));
  });

  it("honors a CacheableKey argument", () => {
    expect(defaultKey("S", "m", [{ cacheKey: "K" }])).toBe("S.m(K)");
  });
});
