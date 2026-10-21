// Queue — persistent, zero-dependency, crash-resilient task queue (docs/AI/tasks/TASK-028-QUEUE.md).

import { randomUUID } from "node:crypto";
import type { KVDB } from "../core/kvdb.js";
import type { Table } from "../core/table.js";
import type { TableSchema, PhysicalRecord } from "../core/table-schema.js";
import { KvdbQueueError } from "../core/errors.js";
import type {
  Job,
  JobState,
  JobOptions,
  JobData,
  QueueOptions,
  QueueStats,
  BackoffOptions,
} from "./types.js";

export interface QueueColumns extends Record<string, unknown> {
  state: JobState;
  priority: number;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  lockToken?: string | null;
  lockExpiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export const QUEUE_TABLE_SCHEMA: TableSchema<QueueColumns> = {
  primaryKey: { name: "id", type: "string" },
  columns: {
    state: { type: "string", index: true },
    priority: { type: "integer", index: true, default: 0 },
    runAt: { type: "integer", index: true, default: 0 },
    attempts: { type: "integer", default: 0 },
    maxAttempts: { type: "integer", default: 3 },
    lockToken: { type: "string", nullable: true },
    lockExpiresAt: { type: "integer", nullable: true, index: true },
    createdAt: { type: "integer" },
    updatedAt: { type: "integer" },
  },
  keys: {
    state: { type: "string", index: true },
    priority: { type: "integer", index: true, default: 0 },
    runAt: { type: "integer", index: true, default: 0 },
    attempts: { type: "integer", default: 0 },
    maxAttempts: { type: "integer", default: 3 },
    lockToken: { type: "string", nullable: true },
    lockExpiresAt: { type: "integer", nullable: true, index: true },
    createdAt: { type: "integer" },
    updatedAt: { type: "integer" },
  },
  indexes: [
    { name: "queue_poll_idx", columns: ["state", "runAt", "priority"] },
  ],
};

export class Queue<Payload = unknown, Result = unknown> {
  private readonly defaultVisibilityTimeoutMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly defaultBackoff: BackoffOptions;
  private readonly table: Table<JobData<Payload, Result>, QueueColumns>;

  constructor(
    readonly name: string,
    private readonly db: KVDB,
    options: QueueOptions = {},
  ) {
    this.defaultVisibilityTimeoutMs = options.defaultVisibilityTimeoutMs ?? 30_000;
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
    this.defaultBackoff = options.defaultBackoff ?? { type: "exponential", delayMs: 1000 };

    this.table = this.db.table<JobData<Payload, Result>, QueueColumns>(
      `_kvdb_queue_${name}`,
      {
        schema: QUEUE_TABLE_SCHEMA,
        autoBatch: false, // Strict transactional isolation for lease polling
      },
    );
  }

  /**
   * Push a job into the queue.
   */
  async push(payload: Payload, options: JobOptions = {}): Promise<Job<Payload, Result>> {
    const now = Date.now();
    const id = options.jobId ?? randomUUID();
    const priority = options.priority ?? 0;
    const delayMs = options.delayMs ?? 0;
    const runAt = now + delayMs;
    const state: JobState = delayMs > 0 ? "delayed" : "waiting";
    const maxAttempts = options.maxAttempts ?? this.defaultMaxAttempts;
    const backoff = options.backoff ?? this.defaultBackoff;

    const data: JobData<Payload, Result> = {
      id,
      payload,
      backoff,
      removeOnComplete: options.removeOnComplete,
    };

    const columns: QueueColumns = {
      state,
      priority,
      runAt,
      attempts: 0,
      maxAttempts,
      lockToken: null,
      lockExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.table.set(id, data, { keys: columns });

    return {
      id,
      state,
      priority,
      runAt,
      attempts: 0,
      maxAttempts,
      createdAt: now,
      updatedAt: now,
      payload,
    };
  }

  /**
   * Push multiple jobs in a single batch.
   */
  async pushMany(
    items: Array<{ payload: Payload; options?: JobOptions }>,
  ): Promise<Job<Payload, Result>[]> {
    const now = Date.now();
    const records = items.map((item) => {
      const opts = item.options ?? {};
      const id = opts.jobId ?? randomUUID();
      const priority = opts.priority ?? 0;
      const delayMs = opts.delayMs ?? 0;
      const runAt = now + delayMs;
      const state: JobState = delayMs > 0 ? "delayed" : "waiting";
      const maxAttempts = opts.maxAttempts ?? this.defaultMaxAttempts;
      const backoff = opts.backoff ?? this.defaultBackoff;

      const data: JobData<Payload, Result> = {
        id,
        payload: item.payload,
        backoff,
        removeOnComplete: opts.removeOnComplete,
      };

      const columns: QueueColumns = {
        state,
        priority,
        runAt,
        attempts: 0,
        maxAttempts,
        lockToken: null,
        lockExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return {
        key: id,
        value: data,
        keys: columns,
        job: {
          id,
          state,
          priority,
          runAt,
          attempts: 0,
          maxAttempts,
          createdAt: now,
          updatedAt: now,
          payload: item.payload,
        },
      };
    });

    await this.table.setMany(
      records.map((r) => ({ key: r.key, value: r.value, keys: r.keys })),
    );

    return records.map((r) => r.job);
  }

  /**
   * Pop the next ready job and atomically acquire a processing lease (visibility timeout).
   */
  async pop(options: { visibilityTimeoutMs?: number } = {}): Promise<Job<Payload, Result> | undefined> {
    const visibilityMs = options.visibilityTimeoutMs ?? this.defaultVisibilityTimeoutMs;
    const now = Date.now();

    // Query candidates ready for execution
    const candidates = await this.table.findRecords({
      where: {
        $or: [
          { state: "waiting", runAt: { $lte: now } },
          { state: "delayed", runAt: { $lte: now } },
          { state: "active", lockExpiresAt: { $lte: now } }, // Recover expired lease
        ],
      },
      sort: [
        { path: "priority", direction: "asc" },
        { path: "runAt", direction: "asc" },
        { path: "createdAt", direction: "asc" },
      ],
      limit: 10,
    });

    for (const record of candidates) {
      const jobId = String(record.key);
      const lockToken = randomUUID();
      const lockExpiresAt = now + visibilityMs;

      try {
        const updated = await this.table.updateRecord(jobId, (current) => {
          if (!current) {
            throw new Error("Job not found");
          }
          const rec = current.columns;
          const isClaimable =
            rec.state === "waiting" ||
            rec.state === "delayed" ||
            (rec.state === "active" && typeof rec.lockExpiresAt === "number" && rec.lockExpiresAt <= now);

          if (!isClaimable) {
            throw new Error("Job already claimed by another worker");
          }

          return {
            value: current.value,
            columns: {
              state: "active",
              lockToken,
              lockExpiresAt,
              attempts: (rec.attempts ?? 0) + 1,
              updatedAt: now,
            },
          };
        });

        return this.toJob({
          key: jobId,
          value: updated.value,
          columns: updated.columns,
        });
      } catch {
        // Lost race with concurrent worker, transaction was safely rolled back. Continue to next candidate.
        continue;
      }
    }

    return undefined;
  }

  /**
   * Acknowledge successful completion of a job.
   */
  async ack(jobId: string, lockToken: string, result?: Result): Promise<boolean> {
    const now = Date.now();
    const record = await this.table.getRecord(jobId);
    if (!record) return false;

    if (record.columns.lockToken !== lockToken) {
      throw new KvdbQueueError(`Cannot ack job "${jobId}": lock token mismatch or lease expired`);
    }

    if (record.value.removeOnComplete) {
      return this.table.delete(jobId);
    }

    await this.table.update(jobId, (current) => ({
      ...current,
      result,
      error: undefined,
      stack: undefined,
    }), {
      keys: {
        state: "completed",
        lockToken: null,
        lockExpiresAt: null,
        updatedAt: now,
      },
    });

    return true;
  }

  /**
   * Reject / fail a job. Triggers backoff retry or marks as failed if maxAttempts exceeded.
   */
  async nack(jobId: string, lockToken: string, error?: Error | string): Promise<boolean> {
    const now = Date.now();
    const record = await this.table.getRecord(jobId);
    if (!record) return false;

    if (record.columns.lockToken !== lockToken) {
      throw new KvdbQueueError(`Cannot nack job "${jobId}": lock token mismatch or lease expired`);
    }

    const attempts = record.columns.attempts ?? 1;
    const maxAttempts = record.columns.maxAttempts ?? this.defaultMaxAttempts;
    const errMessage = error instanceof Error ? error.message : (error ?? "Job execution failed");
    const errStack = error instanceof Error ? error.stack : undefined;

    if (attempts >= maxAttempts) {
      // Dead letter queue
      await this.table.update(jobId, (current) => ({
        ...current,
        error: errMessage,
        stack: errStack,
      }), {
        keys: {
          state: "failed",
          lockToken: null,
          lockExpiresAt: null,
          updatedAt: now,
        },
      });
      return false;
    }

    // Schedule retry with backoff
    const backoff = record.value.backoff ?? this.defaultBackoff;
    const delay = calculateBackoff(backoff, attempts);
    const nextRunAt = now + delay;

    await this.table.update(jobId, (current) => ({
      ...current,
      error: errMessage,
      stack: errStack,
    }), {
      keys: {
        state: "delayed",
        runAt: nextRunAt,
        lockToken: null,
        lockExpiresAt: null,
        updatedAt: now,
      },
    });

    return true;
  }

  /**
   * Extend the visibility timeout lease for a currently processing job.
   */
  async heartbeat(jobId: string, lockToken: string, extendMs?: number): Promise<boolean> {
    const now = Date.now();
    const record = await this.table.getRecord(jobId);
    if (!record) return false;

    if (record.columns.lockToken !== lockToken) {
      return false;
    }

    const duration = extendMs ?? this.defaultVisibilityTimeoutMs;
    await this.table.update(jobId, (current) => current, {
      keys: {
        lockExpiresAt: now + duration,
        updatedAt: now,
      },
    });

    return true;
  }

  /**
   * Get a job by ID.
   */
  async getJob(jobId: string): Promise<Job<Payload, Result> | undefined> {
    const record = await this.table.getRecord(jobId);
    return record ? this.toJob(record) : undefined;
  }

  /**
   * Get queue statistics by state with bounded query protection to prevent memory OOM.
   */
  async getStats(options: { limit?: number } = {}): Promise<QueueStats> {
    const limit = options.limit ?? 10_000;
    const states: JobState[] = ["waiting", "active", "delayed", "completed", "failed"];
    const stats: QueueStats = {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      total: 0,
    };

    for (const s of states) {
      const items = await this.table.findRecords({ where: { state: s }, limit });
      stats[s] = items.length;
      stats.total += items.length;
    }

    return stats;
  }

  /**
   * Re-queue failed jobs back to waiting.
   */
  async retryFailed(jobId?: string): Promise<number> {
    const now = Date.now();
    if (jobId) {
      const record = await this.table.getRecord(jobId);
      if (record && record.columns.state === "failed") {
        await this.table.update(jobId, (c) => ({ ...c, error: undefined, stack: undefined }), {
          keys: {
            state: "waiting",
            runAt: now,
            attempts: 0,
            updatedAt: now,
          },
        });
        return 1;
      }
      return 0;
    }

    const failedRecords = await this.table.findRecords({ where: { state: "failed" } });
    for (const r of failedRecords) {
      await this.table.update(String(r.key), (c) => ({ ...c, error: undefined, stack: undefined }), {
        keys: {
          state: "waiting",
          runAt: now,
          attempts: 0,
          updatedAt: now,
        },
      });
    }

    return failedRecords.length;
  }

  /**
   * Clean old completed or failed jobs.
   */
  async clean(options: { olderThanMs?: number; states?: JobState[] } = {}): Promise<number> {
    const olderThanMs = options.olderThanMs ?? 86_400_000; // default 24h
    const targetStates = options.states ?? ["completed", "failed"];
    const cutoff = Date.now() - olderThanMs;

    const toClean = await this.table.findRecords({
      where: {
        $and: [
          { state: { $in: targetStates } },
          { updatedAt: { $lte: cutoff } },
        ],
      },
    });

    if (toClean.length === 0) return 0;
    return this.table.deleteMany(toClean.map((r) => r.key));
  }

  private toJob(record: PhysicalRecord<QueueColumns, JobData<Payload, Result>>): Job<Payload, Result> {
    return {
      id: String(record.key),
      state: (record.columns.state ?? "waiting") as JobState,
      priority: record.columns.priority ?? 0,
      runAt: record.columns.runAt ?? 0,
      attempts: record.columns.attempts ?? 0,
      maxAttempts: record.columns.maxAttempts ?? this.defaultMaxAttempts,
      lockToken: record.columns.lockToken ?? undefined,
      lockExpiresAt: record.columns.lockExpiresAt ?? undefined,
      createdAt: record.columns.createdAt ?? 0,
      updatedAt: record.columns.updatedAt ?? 0,
      payload: record.value.payload,
      result: record.value.result,
      error: record.value.error,
    };
  }
}

function calculateBackoff(backoff: BackoffOptions, attempts: number): number {
  if (backoff.type === "fixed") {
    return backoff.delayMs;
  }
  return backoff.delayMs * Math.pow(2, Math.max(0, attempts - 1));
}
