// Idempotency types (docs/SPEC.md §20)

export interface IdempotentOptions {
  /**
   * Duration in milliseconds to retain the resolved result.
   * Default: 86_400_000ms (24 hours).
   */
  ttlMs?: number;

  /**
   * Maximum wait timeout in milliseconds for concurrent callers waiting for
   * the active task to complete. Default: 10_000ms.
   */
  timeoutMs?: number;

  /**
   * Polling retry interval in milliseconds while waiting for a concurrent task.
   * Default: 100ms.
   */
  retryIntervalMs?: number;

  /**
   * Table name used to store idempotency state records. Default: "_kvdb_idempotency".
   */
  tableName?: string;
}

export type IdempotencyStatus = "pending" | "resolved" | "rejected";

export interface IdempotencyRecord<T = unknown> {
  status: IdempotencyStatus;
  result?: T;
  error?: string;
  createdAt: number;
}
