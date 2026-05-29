// Cache-key generation for method decorators (docs/SPEC.md §9, KD-5).
//
// Default key = `<ClassName>.<method>(<stable args>)`. Stability comes from the
// canonical serializer (sorted object keys), so equivalent arguments always map
// to the same key. An argument may opt out of serialization by implementing
// CacheableKey — useful for large or circular objects.

import { stableStringify } from "../core/serializer.js";

/** An argument can supply its own cache token instead of being serialized. */
export interface CacheableKey {
  cacheKey: string;
}

function argToken(arg: unknown): string {
  if (
    arg !== null &&
    typeof arg === "object" &&
    typeof (arg as CacheableKey).cacheKey === "string"
  ) {
    return (arg as CacheableKey).cacheKey;
  }
  return stableStringify(arg);
}

/** Build the default cache key for a decorated method call. */
export function defaultKey(className: string, methodName: string, args: unknown[]): string {
  return `${className}.${methodName}(${args.map(argToken).join(",")})`;
}

export type CacheKeyBuilder = (args: unknown[], thisArg: unknown) => string;

/** Resolve the effective cache key from an explicit override or the default. */
export function resolveKey(
  override: string | CacheKeyBuilder | undefined,
  thisArg: unknown,
  methodName: string,
  args: unknown[],
): string {
  if (typeof override === "string") return override;
  if (typeof override === "function") return override(args, thisArg);
  const className =
    (thisArg as { constructor?: { name?: string } } | null)?.constructor?.name ?? "fn";
  return defaultKey(className, methodName, args);
}
