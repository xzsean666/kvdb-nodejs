import { describe, it, expect } from "vitest";
import { SqliteCacheStore } from "../../src/cache/stores/sqlite-store.js";
import { Cache } from "../../src/cache/cache.js";

describe("SqliteCacheStore", () => {
  it("set/get/has/delete/clear", () => {
    const store = new SqliteCacheStore({ file: ":memory:" });
    store.set("a", '{"n":1}');
    expect(store.get("a")?.value).toBe('{"n":1}');
    expect(store.has("a")).toBe(true);
    expect(store.delete("a")).toBe(true);
    expect(store.get("a")).toBeUndefined();
    store.set("b", "1");
    store.clear();
    expect(store.has("b")).toBe(false);
    store.close();
  });

  it("honors TTL", () => {
    const store = new SqliteCacheStore();
    store.set("a", "1", -1);
    expect(store.get("a")).toBeUndefined();
    store.close();
  });

  it("iterates by prefix", async () => {
    const store = new SqliteCacheStore();
    store.set("u:1", "a");
    store.set("u:2", "b");
    store.set("p:1", "c");
    const keys: string[] = [];
    for await (const [key] of store.iterator("u:")) keys.push(key);
    expect(keys.sort()).toEqual(["u:1", "u:2"]);
    store.close();
  });
});

describe("Cache with sqlite-memory tier", () => {
  it("works as a single tier", async () => {
    const cache = new Cache({ driver: "sqlite-memory" });
    await cache.set("k", { a: 1 });
    expect(await cache.get("k")).toEqual({ a: 1 });
  });

  it("works as a lower tier behind memory (backfill)", async () => {
    const cache = new Cache({ stores: ["memory", "sqlite-memory"] });
    await cache.set("k", 42);
    expect(await cache.get<number>("k")).toBe(42);
  });
});
