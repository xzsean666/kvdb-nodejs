// @Cacheable / @CacheClear — TC39 standard method decorators (docs/SPEC.md §9).
//
// These delegate to Cache.wrap()/delete() — they add no caching logic of their
// own, they only compute a key and call the cache engine. A cache must be
// available either via `options.cache` or a process-wide default set with
// setDefaultCache().
//
// Requires TC39 standard decorators (TS 5.x default). Do NOT enable
// experimentalDecorators — the legacy signature is incompatible (AGENTS.md §7).

import type { Cache } from "../cache/cache.js";
import { resolveKey } from "./cache-key.js";
import type { CacheKeyBuilder } from "./cache-key.js";
import { KvdbConfigError } from "../core/errors.js";

let defaultCache: Cache | undefined;

/** Set the cache used by decorators that don't specify one. */
export function setDefaultCache(cache: Cache): void {
  defaultCache = cache;
}

/** Clear the process-wide default cache reference (mainly for tests). */
export function clearDefaultCache(): void {
  defaultCache = undefined;
}

function requireCache(explicit: Cache | undefined): Cache {
  const cache = explicit ?? defaultCache;
  if (cache === undefined) {
    throw new KvdbConfigError(
      "No cache available for the decorator. Pass { cache } or call setDefaultCache(cache).",
    );
  }
  return cache;
}

export interface CacheableOptions {
  cache?: Cache;
  ttlMs?: number;
  refreshThreshold?: number;
  cacheKey?: string | CacheKeyBuilder;
}

/** Cache the result of an (async) method, keyed by class+method+arguments. */
export function Cacheable(options: CacheableOptions = {}) {
  return function <This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ): (this: This, ...args: Args) => Promise<Awaited<Return>> {
    const methodName = String(context.name);
    return async function (this: This, ...args: Args): Promise<Awaited<Return>> {
      const cache = requireCache(options.cache);
      const key = resolveKey(options.cacheKey, this, methodName, args);
      return cache.wrap<Awaited<Return>>(
        key,
        () => Promise.resolve(target.apply(this, args)),
        { ttlMs: options.ttlMs, refreshThreshold: options.refreshThreshold },
      );
    };
  };
}

export interface CacheClearOptions {
  cache?: Cache;
  /**
   * Key (or builder) to evict. Usually required: to clear another method's
   * entries the key must match how that method was cached (the default key
   * embeds the other method's name, so an explicit value is normally needed).
   */
  cacheKey: string | CacheKeyBuilder;
}

/** Run the method, then evict a cache key. */
export function CacheClear(options: CacheClearOptions) {
  return function <This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ): (this: This, ...args: Args) => Promise<Awaited<Return>> {
    const methodName = String(context.name);
    return async function (this: This, ...args: Args): Promise<Awaited<Return>> {
      const result = (await target.apply(this, args)) as Awaited<Return>;
      const cache = requireCache(options.cache);
      await cache.delete(resolveKey(options.cacheKey, this, methodName, args));
      return result;
    };
  };
}
