// Distributed Lock & Mutex types (docs/SPEC.md §17)

export interface LockOptions {
  /**
   * Lock lease TTL in milliseconds. The lock automatically expires if not
   * renewed or released. Default: 10,000ms.
   */
  ttlMs?: number;

  /**
   * Maximum wait timeout in milliseconds when competing for a held lock.
   * If set to 0, behaves as a non-blocking try-lock. Default: 5,000ms.
   */
  waitTimeoutMs?: number;

  /**
   * Polling retry interval in milliseconds while waiting for a lock.
   * Default: 100ms.
   */
  retryIntervalMs?: number;

  /**
   * Whether to periodically extend the lock's TTL while the lock handle
   * is active (auto-heartbeat). Default: true.
   */
  autoHeartbeat?: boolean;
}

export interface LockHandle {
  readonly key: string;
  readonly token: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;

  /**
   * Manually extend the lease TTL.
   */
  extend(additionalTtlMs?: number): Promise<boolean>;

  /**
   * Release the lock. Safe against releasing locks acquired by other processes
   * by verifying the owner token.
   */
  release(): Promise<boolean>;
}

export interface LockRecord {
  token: string;
  acquiredAt: number;
  expiresAt: number;
}
