// Rate limiter types (docs/SPEC.md §19)

export interface RateLimiterOptions {
  /**
   * The sliding window duration in milliseconds (e.g., 60_000 for 1 minute).
   */
  windowMs: number;

  /**
   * Maximum allowed token consumption within the window.
   */
  limit: number;

  /**
   * Internal table name used to store rate limit counters. Default: "_kvdb_rate_limits".
   */
  tableName?: string;
}

export interface RateLimitResult {
  /**
   * Whether the request is permitted.
   */
  readonly allowed: boolean;

  /**
   * Configured limit.
   */
  readonly limit: number;

  /**
   * Estimated remaining tokens in the current sliding window.
   */
  readonly remaining: number;

  /**
   * Milliseconds until the current sliding window completely rolls over.
   */
  readonly resetMs: number;

  /**
   * Estimated current total consumption across the sliding window.
   */
  readonly current: number;
}
