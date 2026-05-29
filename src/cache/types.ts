// KVStore — the lowest-level key/value contract (docs/ARCHITECTURE.md KD-1).
//
// This is intentionally a Map-superset plus TTL, modeled on keyv's adapter contract.
// It is the contract every Cache backend implements, and the minimal common
// denominator for raw KV semantics. The richer queryable `Driver` contract
// (drivers/types.ts) extends this — it is NOT merged with it.

import type { MaybePromise } from "../types/json.js";

/**
 * A stored entry as seen by a KVStore. The value is opaque to the store:
 * higher layers serialize/deserialize (see core/serializer.ts). `expiresAt`
 * is an absolute epoch-millis timestamp; `undefined` means no expiry.
 */
export interface RawEntry {
  value: string;
  expiresAt?: number;
}

/** A key/value pair for batch writes. `ttlMs` is relative milliseconds. */
export interface KVEntry {
  key: string;
  value: string;
  ttlMs?: number;
}

/**
 * The lowest-level storage contract. Methods may be sync or async; callers
 * always `await`. Batch and iteration methods are optional — the core falls
 * back to per-key loops when a store does not implement them.
 *
 * Convention (KD-7): storing `undefined`/deletion are distinct; a store never
 * holds an `undefined` value — callers translate that to `delete` upstream.
 */
export interface KVStore {
  get(key: string): MaybePromise<RawEntry | undefined>;
  set(key: string, value: string, ttlMs?: number): MaybePromise<void>;
  delete(key: string): MaybePromise<boolean>;
  has(key: string): MaybePromise<boolean>;
  clear(): MaybePromise<void>;

  getMany?(keys: string[]): MaybePromise<(RawEntry | undefined)[]>;
  setMany?(entries: KVEntry[]): MaybePromise<void>;
  deleteMany?(keys: string[]): MaybePromise<number>;

  /** Iterate entries, optionally restricted to keys starting with `prefix`. */
  iterator?(prefix?: string): AsyncGenerator<[string, RawEntry]>;

  /** Release any resources (file handles, timers). Optional for in-memory stores. */
  close?(): MaybePromise<void>;
}
