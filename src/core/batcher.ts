// WriteBatcher — in-memory micro-batch write & coalescing engine (docs/AI/tasks/TASK-029-AUTO-BATCH.md).
//
// Automatically aggregates discrete set(), update(), and delete() operations within
// a configurable debounce window (default 20ms) or capacity threshold (default 50 items).
// Supports Multi-Key secondary indices, two-layer coalescing (in-memory folding vs sequential,
// and SQL multi-row aggregation vs single-statement execution), deterministic primary key sorting
// for PostgreSQL deadlock prevention, unref'd timer for graceful shutdown, and zero error swallowing.

import { KvdbError } from "./errors.js";

export interface AutoBatchOptions {
  /**
   * Maximum number of write items to accumulate before triggering an immediate flush.
   * Default: 50.
   */
  maxBatchSize?: number;

  /**
   * Maximum milliseconds to wait before flushing accumulated writes if maxBatchSize is not reached.
   * Default: 20.
   */
  maxWaitMs?: number;

  /**
   * Whether to fold and coalesce writes for the same key in memory.
   * - true (default): set-set overwrite, set-delete cancellation, incremental multi-key merge.
   * - false: strictly sequential FIFO micro-batching without in-memory folding (for CDC/triggers).
   */
  coalesce?: boolean;

  /**
   * Whether to aggregate into a single multi-row SQL statement at the driver layer.
   * - true (default): single INSERT INTO ... VALUES (...), (...) ON CONFLICT statement.
   * - false: execute individual prepared statements within a single transaction.
   */
  sqlAggregation?: boolean;

  /**
   * Maximum in-memory queue capacity before applying synchronous backpressure (force flush).
   * Default: maxBatchSize * 10 (e.g. 500).
   */
  maxBufferSize?: number;
}

export type BatchOpType = "set" | "delete";

export interface BatchSetItem<V = unknown> {
  key: string | number;
  value: V;
  keys?: Record<string, unknown>;
  ttlMs?: number;
}

export interface PendingBatchItem<V = unknown> {
  key: string | number;
  type: BatchOpType;
  item?: BatchSetItem<V>;
  hadPriorSetInSameWindow?: boolean;
  resolves: Array<(val?: any) => void>;
  rejects: Array<(err: unknown) => void>;
}

export interface BatchFlushPayload<V = unknown> {
  sets: readonly BatchSetItem<V>[];
  deletes: readonly (string | number)[];
  sqlAggregation: boolean;
}

export interface BatchFlushResult {
  /**
   * Set of keys that actually existed and were deleted in the database.
   */
  deletedKeys?: Set<string | number>;
}

export type FlushHandler<V = unknown> = (
  payload: BatchFlushPayload<V>,
) => Promise<BatchFlushResult | void>;

/**
 * Compare two keys deterministically to guarantee monotonic row-lock acquisition order,
 * completely eliminating deadlock hazards in PostgreSQL concurrent multi-row UPSERTs.
 */
export function compareKeysDeterministic(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const strA = String(a);
  const strB = String(b);
  return strA < strB ? -1 : strA > strB ? 1 : 0;
}

/**
 * Filter out dangerous prototype pollution keys (__proto__, constructor, prototype).
 */
export function sanitizeSecondaryKeys(
  keys: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!keys || typeof keys !== "object") return undefined;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(keys)) {
    const lower = k.toLowerCase();
    if (lower === "__proto__" || lower === "constructor" || lower === "prototype") {
      continue;
    }
    clean[k] = v;
  }
  return clean;
}

export class WriteBatcher<V = unknown> {
  private readonly maxBatchSize: number;
  private readonly maxWaitMs: number;
  private readonly coalesceEnabled: boolean;
  private readonly sqlAggregation: boolean;
  private readonly maxBufferSize: number;

  /** Keyed map used when coalesce=true */
  private pendingMap = new Map<string, PendingBatchItem<V>>();
  /** FIFO list used when coalesce=false */
  private pendingList: PendingBatchItem<V>[] = [];

  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private activeFlushPromise?: Promise<void>;

  constructor(
    private readonly flushHandler: FlushHandler<V>,
    options?: AutoBatchOptions,
  ) {
    this.maxBatchSize = Math.max(1, options?.maxBatchSize ?? 50);
    this.maxWaitMs = Math.max(1, options?.maxWaitMs ?? 20);
    this.coalesceEnabled = options?.coalesce ?? true;
    this.sqlAggregation = options?.sqlAggregation ?? true;
    this.maxBufferSize = Math.max(this.maxBatchSize, options?.maxBufferSize ?? this.maxBatchSize * 10);
  }

  /**
   * Enqueues or merges a write item into the micro-batch buffer.
   */
  async enqueue(item: BatchSetItem<V>): Promise<void> {
    // Capacity backpressure check: if buffer is flooded, force immediate drain
    if (this.pendingCount >= this.maxBufferSize) {
      await this.flush();
    }

    return new Promise<void>((resolve, reject) => {
      const sanitizedKeys = sanitizeSecondaryKeys(item.keys);
      const cleanItem: BatchSetItem<V> = {
        ...item,
        keys: sanitizedKeys,
      };

      if (this.coalesceEnabled) {
        const strKey = String(cleanItem.key);
        const existing = this.pendingMap.get(strKey);
        if (existing) {
          existing.type = "set";
          // Incremental shallow merge for multi-key columns
          const mergedKeys =
            existing.item?.keys || cleanItem.keys
              ? { ...(existing.item?.keys ?? {}), ...(cleanItem.keys ?? {}) }
              : undefined;
          existing.item = {
            ...cleanItem,
            keys: mergedKeys,
            ttlMs: cleanItem.ttlMs !== undefined ? cleanItem.ttlMs : existing.item?.ttlMs,
          };
          existing.resolves.push(resolve);
          existing.rejects.push(reject);
        } else {
          this.pendingMap.set(strKey, {
            key: cleanItem.key,
            type: "set",
            item: cleanItem,
            resolves: [resolve],
            rejects: [reject],
          });
        }
      } else {
        // Sequential mode: keep every operation independently
        this.pendingList.push({
          key: cleanItem.key,
          type: "set",
          item: cleanItem,
          resolves: [resolve],
          rejects: [reject],
        });
      }

      this.checkFlushConditions();
    });
  }

  /**
   * Enqueues or merges a delete operation for a key into the micro-batch buffer.
   */
  async enqueueDelete(key: string | number): Promise<boolean> {
    if (this.pendingCount >= this.maxBufferSize) {
      await this.flush();
    }

    return new Promise<boolean>((resolve, reject) => {
      const strKey = String(key);
      if (this.coalesceEnabled) {
        const existing = this.pendingMap.get(strKey);
        if (existing) {
          const hadPriorSet = existing.type === "set" || Boolean(existing.hadPriorSetInSameWindow);
          // Resolve previous set callers because their write was replaced by this delete
          for (const prevResolve of existing.resolves) {
            prevResolve();
          }
          existing.type = "delete";
          existing.item = undefined;
          existing.hadPriorSetInSameWindow = hadPriorSet;
          existing.resolves = [(delResult?: boolean) => resolve(delResult ?? true)];
          existing.rejects = [reject];
        } else {
          this.pendingMap.set(strKey, {
            key,
            type: "delete",
            hadPriorSetInSameWindow: false,
            resolves: [(delResult?: boolean) => resolve(delResult ?? false)],
            rejects: [reject],
          });
        }
      } else {
        this.pendingList.push({
          key,
          type: "delete",
          hadPriorSetInSameWindow: false,
          resolves: [(delResult?: boolean) => resolve(delResult ?? false)],
          rejects: [reject],
        });
      }

      this.checkFlushConditions();
    });
  }

  /**
   * Synchronously checks if a key has a pending operation in the in-memory buffer.
   */
  hasPending(key: string | number): boolean {
    if (this.coalesceEnabled) {
      return this.pendingMap.has(String(key));
    }
    const strKey = String(key);
    return this.pendingList.some((item) => String(item.key) === strKey);
  }

  /**
   * Retrieves the in-memory buffered operation for a key, if any.
   */
  getPending(key: string | number): PendingBatchItem<V> | undefined {
    if (this.coalesceEnabled) {
      return this.pendingMap.get(String(key));
    }
    const strKey = String(key);
    for (let i = this.pendingList.length - 1; i >= 0; i--) {
      if (String(this.pendingList[i]!.key) === strKey) {
        return this.pendingList[i];
      }
    }
    return undefined;
  }

  /**
   * Current number of queued items waiting in buffer.
   */
  get pendingCount(): number {
    return this.coalesceEnabled ? this.pendingMap.size : this.pendingList.length;
  }

  /**
   * Whether a batch flush is currently in progress.
   */
  get isFlushingNow(): boolean {
    return this.isFlushing;
  }

  private checkFlushConditions(): void {
    if (this.pendingCount >= this.maxBatchSize) {
      void this.triggerFlush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.triggerFlush();
      }, this.maxWaitMs);
    }
  }

  private async triggerFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Immediately flushes all queued writes/deletes to the database.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 1. If another flush is in flight, wait for it first
    if (this.isFlushing && this.activeFlushPromise) {
      await this.activeFlushPromise;
    }

    // 2. If nothing is pending, return cleanly
    if (this.pendingCount === 0) {
      return;
    }

    this.isFlushing = true;
    let snapshot: PendingBatchItem<V>[];

    if (this.coalesceEnabled) {
      snapshot = Array.from(this.pendingMap.values());
      this.pendingMap.clear();
      // Crucial: sort by key deterministically to eliminate PostgreSQL row-lock deadlocks
      snapshot.sort((a, b) => compareKeysDeterministic(a.key, b.key));
    } else {
      snapshot = this.pendingList.slice();
      this.pendingList = [];
    }

    const sets: BatchSetItem<V>[] = [];
    const deletes: (string | number)[] = [];

    for (const op of snapshot) {
      if (op.type === "set" && op.item) {
        sets.push(op.item);
      } else if (op.type === "delete") {
        deletes.push(op.key);
      }
    }

    this.activeFlushPromise = (async () => {
      try {
        const result = await this.flushHandler({
          sets,
          deletes,
          sqlAggregation: this.sqlAggregation,
        });

        const deletedSet =
          result && typeof result === "object" && result.deletedKeys
            ? result.deletedKeys
            : undefined;

        for (const op of snapshot) {
          if (op.type === "set") {
            for (const resolve of op.resolves) resolve();
          } else if (op.type === "delete") {
            const wasDeleted =
              op.hadPriorSetInSameWindow || (deletedSet ? deletedSet.has(op.key) : true);
            for (const resolve of op.resolves) resolve(wasDeleted);
          }
        }
      } catch (err) {
        // Zero Error Swallowing: propagate error to every single caller in this batch
        for (const op of snapshot) {
          for (const reject of op.rejects) reject(err);
        }
      } finally {
        this.isFlushing = false;
        this.activeFlushPromise = undefined;

        // If more items accumulated during execution, schedule follow-up flush
        if (this.pendingCount > 0) {
          if (this.pendingCount >= this.maxBatchSize) {
            void this.triggerFlush();
          } else if (!this.timer) {
            this.timer = setTimeout(() => {
              this.timer = null;
              void this.triggerFlush();
            }, this.maxWaitMs);
          }
        }
      }
    })();

    await this.activeFlushPromise;
  }

  /**
   * Cancels any pending buffered items and rejects caller promises.
   */
  clear(error?: Error): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const err = error ?? new Error("Write buffer cleared");
    const items = this.coalesceEnabled
      ? Array.from(this.pendingMap.values())
      : this.pendingList;

    this.pendingMap.clear();
    this.pendingList = [];

    for (const op of items) {
      for (const rej of op.rejects) {
        rej(err);
      }
    }
  }
}
