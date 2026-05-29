// 10 — @Cacheable / @CacheClear method decorators.
//
// Run:  pnpm example examples/10-decorator-cache.ts
//   (decorators need a TS transform — that is why examples run via tsx, not bare node.)
//
// @Cacheable memoizes an async method's result, keyed by class + method +
// arguments. @CacheClear evicts a key after the method runs. Both delegate to a
// Cache — provide one per-decorator or set a process-wide default.

import { Cache, Cacheable, CacheClear, setDefaultCache } from "kvdb-sdk";

// One shared cache for every decorator that doesn't specify its own.
setDefaultCache(new Cache({ driver: "memory" }));

let dbHits = 0; // stand-in for an expensive call (DB / HTTP / compute)

class UserService {
  // Memoized by the `id` argument; second call with the same id is a cache hit.
  @Cacheable({ ttlMs: 60_000 })
  async getUser(id: string): Promise<{ id: string; name: string }> {
    dbHits++;
    return { id, name: `User ${id}` };
  }

  // Custom, explicit cache key (so other methods can target it).
  @Cacheable({ cacheKey: (args) => `user:${args[0]}` })
  async getName(id: string): Promise<string> {
    dbHits++;
    return `Name of ${id}`;
  }

  // Runs, then evicts `user:<id>` — the next getName() re-computes.
  @CacheClear({ cacheKey: (args) => `user:${args[0]}` })
  async rename(id: string, _name: string): Promise<void> {
    /* imagine a write to the source of truth here */
  }
}

const svc = new UserService();

await svc.getUser("1");
await svc.getUser("1"); // cache hit — no second "DB" call
await svc.getUser("2"); // different arg — miss
console.log("getUser DB hits (expect 2):", dbHits);

dbHits = 0;
await svc.getName("42"); // miss -> computes
await svc.getName("42"); // hit
console.log("getName DB hits before evict (expect 1):", dbHits);

await svc.rename("42", "New"); // evicts user:42
await svc.getName("42"); // miss again -> recomputes
console.log("getName DB hits after evict (expect 2):", dbHits);
