// Shared TTL/expiry helpers (docs/ARCHITECTURE.md KD-6, §4.1).
//
// Expiry is computed from an absolute `expiresAt` (epoch millis). Backends
// without native TTL (SQLite, Postgres) and the in-memory cache all use these
// helpers so expiry semantics are identical everywhere.

import type { RawEntry } from "../cache/types.js";

/** Convert a relative TTL (ms) into an absolute expiry timestamp, if provided. */
export function expiresAtFromTtl(ttlMs: number | undefined, nowMs: number): number | undefined {
  return ttlMs === undefined ? undefined : nowMs + ttlMs;
}

/** True if the entry has expired as of `nowMs`. */
export function isExpired(entry: RawEntry, nowMs: number): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= nowMs;
}

/** Remaining lifetime in ms, or Infinity if the entry never expires. */
export function remainingTtl(entry: RawEntry, nowMs: number): number {
  return entry.expiresAt === undefined ? Infinity : entry.expiresAt - nowMs;
}
