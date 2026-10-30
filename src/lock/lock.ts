// Distributed Lock and Mutex implementation (docs/SPEC.md §17)
import { randomUUID } from "node:crypto";
import type { KVDB } from "../core/kvdb.js";
import type { Table } from "../core/table.js";
import { KvdbLockError } from "../core/errors.js";
import type { LockHandle, LockOptions, LockRecord } from "./types.js";

const DEFAULT_LOCK_TABLE = "_kvdb_locks";
const DEFAULT_TTL_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;

export class LockManager {
  private readonly db: KVDB;
  private readonly lockTable: Table<LockRecord>;

  constructor(db: KVDB, tableName: string = DEFAULT_LOCK_TABLE) {
    this.db = db;
    this.lockTable = db.table<LockRecord>(tableName, { autoBatch: false });
  }

  /**
   * Acquire a distributed lock. Returns a `LockHandle` if acquired, or `null`
   * if the lock could not be obtained within `waitTimeoutMs`.
   */
  async acquireLock(key: string, options: LockOptions = {}): Promise<LockHandle | null> {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const autoHeartbeat = options.autoHeartbeat ?? true;

    const token = randomUUID();
    const startTime = Date.now();

    while (true) {
      const now = Date.now();
      let acquired = false;
      let expiresAt = now + ttlMs;

      try {
        await this.lockTable.update(
          key,
          (curr) => {
            const currentTime = Date.now();
            if (curr && typeof curr.expiresAt === "number" && curr.expiresAt > currentTime) {
              // Held by an active process
              throw new Error("__KVDB_LOCKED__");
            }
            expiresAt = currentTime + ttlMs;
            return {
              token,
              acquiredAt: currentTime,
              expiresAt,
            };
          },
          { upsert: true, ttlMs },
        );
        acquired = true;
      } catch (err: any) {
        if (err?.message !== "__KVDB_LOCKED__") {
          // In case of write contention or concurrency, we continue looping until timeout
        }
      }

      if (acquired) {
        let active = true;
        let heartbeatTimer: NodeJS.Timeout | undefined;

        const release = async (): Promise<boolean> => {
          if (!active) return false;
          active = false;
          if (heartbeatTimer) clearInterval(heartbeatTimer);

          try {
            await this.lockTable.update(
              key,
              (curr) => {
                if (curr && curr.token === token) {
                  return { ...curr, expiresAt: 0 };
                }
                return curr;
              },
              { ttlMs: 1 },
            );
            return true;
          } catch {
            return false;
          }
        };

        const extend = async (additionalTtlMs: number = ttlMs): Promise<boolean> => {
          if (!active) return false;
          try {
            let success = false;
            await this.lockTable.update(
              key,
              (curr) => {
                if (curr && curr.token === token) {
                  const newExp = Date.now() + additionalTtlMs;
                  expiresAt = newExp;
                  success = true;
                  return { ...curr, expiresAt: newExp };
                }
                throw new Error("__KVDB_LOCK_LOST__");
              },
              { ttlMs: additionalTtlMs },
            );
            return success;
          } catch {
            active = false;
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            return false;
          }
        };

        if (autoHeartbeat && ttlMs >= 1000) {
          const interval = Math.max(500, Math.floor(ttlMs / 2));
          heartbeatTimer = setInterval(() => {
            extend().catch(() => {});
          }, interval);
          heartbeatTimer.unref?.();
        }

        const handle: LockHandle = {
          key,
          token,
          acquiredAt: now,
          get expiresAt() {
            return expiresAt;
          },
          extend,
          release,
        };

        return handle;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= waitTimeoutMs) {
        return null;
      }

      const nextSleep = Math.min(retryIntervalMs, waitTimeoutMs - elapsed);
      if (nextSleep > 0) {
        await new Promise((resolve) => setTimeout(resolve, nextSleep));
      }
    }
  }

  /**
   * Execute an async function within a distributed lock scope.
   * Automatically acquires the lock, sustains it via heartbeat, and ensures
   * release in a `finally` block.
   */
  async withLock<T>(
    key: string,
    fn: (handle: LockHandle) => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const handle = await this.acquireLock(key, options);
    if (!handle) {
      const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      throw new KvdbLockError(
        `Failed to acquire lock for key "${key}" within ${waitTimeoutMs}ms`,
      );
    }

    try {
      return await fn(handle);
    } finally {
      await handle.release().catch(() => {});
    }
  }
}
