// High-performance Sliding Window Rate Limiter (docs/SPEC.md §19)
import type { KVDB } from "../core/kvdb.js";
import type { Table } from "../core/table.js";
import type { RateLimiterOptions, RateLimitResult } from "./types.js";

const DEFAULT_LIMITER_TABLE = "_kvdb_rate_limits";

export class RateLimiter {
  private readonly table: Table<number>;
  readonly options: Readonly<RateLimiterOptions>;

  constructor(db: KVDB, options: RateLimiterOptions) {
    if (options.windowMs <= 0) {
      throw new Error("RateLimiter windowMs must be greater than 0");
    }
    if (options.limit <= 0) {
      throw new Error("RateLimiter limit must be greater than 0");
    }
    this.options = { ...options };
    this.table = db.table<number>(options.tableName ?? DEFAULT_LIMITER_TABLE, {
      autoBatch: false,
    });
  }

  /**
   * Consume tokens from the rate limit bucket.
   */
  async consume(key: string, tokens: number = 1): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = this.options.windowMs;
    const curWindow = Math.floor(now / windowMs) * windowMs;
    const prevWindow = curWindow - windowMs;
    const curKey = `${key}:${curWindow}`;
    const prevKey = `${key}:${prevWindow}`;

    // Read previous window counter
    const prevVal = (await this.table.get(prevKey)) ?? 0;

    // Atomically increment current window counter with double-window TTL
    const curVal = await this.table.increment(curKey, tokens, {
      ttlMs: windowMs * 2,
    });

    const elapsed = now - curWindow;
    const weight = Math.max(0, 1 - elapsed / windowMs);
    const estimated = Math.floor(prevVal * weight + curVal);

    const allowed = estimated <= this.options.limit;
    const remaining = Math.max(0, this.options.limit - estimated);
    const resetMs = windowMs - elapsed;

    return {
      allowed,
      limit: this.options.limit,
      remaining,
      resetMs,
      current: estimated,
    };
  }

  /**
   * Check current consumption without consuming tokens.
   */
  async check(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = this.options.windowMs;
    const curWindow = Math.floor(now / windowMs) * windowMs;
    const prevWindow = curWindow - windowMs;
    const curKey = `${key}:${curWindow}`;
    const prevKey = `${key}:${prevWindow}`;

    const [prevValRaw, curValRaw] = await Promise.all([
      this.table.get(prevKey),
      this.table.get(curKey),
    ]);

    const prevVal = prevValRaw ?? 0;
    const curVal = curValRaw ?? 0;

    const elapsed = now - curWindow;
    const weight = Math.max(0, 1 - elapsed / windowMs);
    const estimated = Math.floor(prevVal * weight + curVal);

    const allowed = estimated <= this.options.limit;
    const remaining = Math.max(0, this.options.limit - estimated);
    const resetMs = windowMs - elapsed;

    return {
      allowed,
      limit: this.options.limit,
      remaining,
      resetMs,
      current: estimated,
    };
  }

  /**
   * Reset rate limit state for a given key.
   */
  async reset(key: string): Promise<void> {
    const now = Date.now();
    const windowMs = this.options.windowMs;
    const curWindow = Math.floor(now / windowMs) * windowMs;
    const prevWindow = curWindow - windowMs;
    await Promise.all([
      this.table.delete(`${key}:${curWindow}`),
      this.table.delete(`${key}:${prevWindow}`),
    ]);
  }
}
