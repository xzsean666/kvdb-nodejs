// Idempotency execution guard (docs/SPEC.md §20)
import type { KVDB } from "../core/kvdb.js";
import type { Table } from "../core/table.js";
import { KvdbIdempotencyError } from "../core/errors.js";
import type { IdempotentOptions, IdempotencyRecord } from "./types.js";

const DEFAULT_IDEMPOTENCY_TABLE = "_kvdb_idempotency";
const DEFAULT_TTL_MS = 86_400_000; // 24 hours
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;

export class IdempotencyManager {
  private readonly table: Table<IdempotencyRecord>;

  constructor(db: KVDB, tableName: string = DEFAULT_IDEMPOTENCY_TABLE) {
    this.table = db.table<IdempotencyRecord>(tableName, { autoBatch: false });
  }

  /**
   * Execute an operation idempotently.
   * Concurrent invocations with the same key wait for the in-flight execution,
   * while future invocations within `ttlMs` return the cached result.
   */
  async idempotent<T>(
    key: string,
    fn: () => Promise<T>,
    options: IdempotentOptions = {},
  ): Promise<T> {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const startTime = Date.now();

    while (true) {
      // 1. Fast read path: if already resolved, return immediately without write contention
      const cached = await this.table.get(key);
      if (cached?.status === "resolved") {
        return cached.result as T;
      }

      // 2. Try to claim execution as the primary worker
      let isClaimer = false;
      let existingRecord: IdempotencyRecord | undefined;

      try {
        await this.table.update(
          key,
          (curr) => {
            const now = Date.now();
            if (!curr || curr.status === "rejected") {
              isClaimer = true;
              return { status: "pending", createdAt: now };
            }
            // If another execution has been pending for longer than timeoutMs, assume abandoned/crashed
            if (curr.status === "pending" && now - curr.createdAt > timeoutMs) {
              isClaimer = true;
              return { status: "pending", createdAt: now };
            }
            existingRecord = curr;
            return curr;
          },
          { upsert: true, ttlMs },
        );
      } catch {
        // Retry loop on write contention
      }

      if (isClaimer) {
        try {
          const result = await fn();
          await this.table.update(
            key,
            () => ({
              status: "resolved",
              result,
              createdAt: Date.now(),
            }),
            { ttlMs },
          );
          return result;
        } catch (err: any) {
          const errMsg = err?.message ?? String(err);
          // Mark as rejected so concurrent callers can detect the failure or retry
          await this.table
            .update(
              key,
              () => ({
                status: "rejected",
                error: errMsg,
                createdAt: Date.now(),
              }),
              { ttlMs: 10_000 },
            )
            .catch(() => {});
          throw err;
        }
      }

      // 3. Competing caller path: if existing execution was resolved, return result
      if (existingRecord?.status === "resolved") {
        return existingRecord.result as T;
      }

      // 4. Poll until the active execution resolves, fails, or times out
      while (Date.now() - startTime < timeoutMs) {
        const nextSleep = Math.min(retryIntervalMs, timeoutMs - (Date.now() - startTime));
        if (nextSleep > 0) {
          await new Promise((resolve) => setTimeout(resolve, nextSleep));
        }

        const pollRec = await this.table.get(key);
        if (pollRec?.status === "resolved") {
          return pollRec.result as T;
        }
        if (!pollRec || pollRec.status === "rejected") {
          // The previous attempt failed or expired; break out to the outer loop to reclaim
          break;
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new KvdbIdempotencyError(
          `Idempotent execution for key "${key}" timed out waiting for concurrent process to finish (${timeoutMs}ms)`,
        );
      }
    }
  }
}
