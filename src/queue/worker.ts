// Worker — concurrent job runner with visibility timeout leases, auto-heartbeat,
// backoff retries, and graceful shutdown (docs/AI/tasks/TASK-028-QUEUE.md).

import { EventEmitter } from "node:events";
import type { Queue } from "./queue.js";
import type {
  Job,
  JobProcessor,
  WorkerOptions,
} from "./types.js";

export interface WorkerEvents<Payload = unknown, Result = unknown> {
  completed: (job: Job<Payload, Result>, result: Result) => void;
  failed: (job: Job<Payload, Result>, error: Error) => void;
  error: (error: Error) => void;
  drained: () => void;
  paused: () => void;
  resumed: () => void;
  closed: () => void;
}

export class Worker<Payload = unknown, Result = unknown> extends EventEmitter {
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly visibilityTimeoutMs: number;
  readonly autoHeartbeat: boolean;

  private isRunning = false;
  private isPaused = false;
  private activeJobs = new Map<string, { job: Job<Payload, Result>; heartbeatTimer?: NodeJS.Timeout }>();
  private activePromises = new Set<Promise<void>>();
  private dispatchPromise?: Promise<void>;
  private pollTimeout?: NodeJS.Timeout;
  private pollResolve?: () => void;

  constructor(
    readonly queue: Queue<Payload, Result>,
    private readonly processor: JobProcessor<Payload, Result>,
    options: WorkerOptions = {},
  ) {
    super();
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1000);
    this.visibilityTimeoutMs = Math.max(1000, options.visibilityTimeoutMs ?? 30_000);
    this.autoHeartbeat = options.autoHeartbeat ?? true;
  }

  get running(): boolean {
    return this.isRunning;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get active(): number {
    return this.activeJobs.size;
  }

  /**
   * Start the worker and begin polling for ready jobs.
   */
  start(): this {
    if (this.isRunning) return this;
    this.isRunning = true;
    this.isPaused = false;
    this.dispatchPromise = this.dispatchLoop();
    return this;
  }

  /**
   * Pause polling for new jobs. In-flight jobs will continue until completion.
   */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.emit("paused");
  }

  /**
   * Resume polling for jobs.
   */
  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.emit("resumed");
    this.wakeUp();
  }

  /**
   * Graceful shutdown: stop polling, clear timers, and await all active in-flight jobs.
   */
  async close(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.isPaused = false;

    // Wake up any sleeping poll loop
    this.wakeUp();

    // Await dispatch loop to exit
    if (this.dispatchPromise) {
      await this.dispatchPromise.catch(() => {});
      this.dispatchPromise = undefined;
    }

    // Await all in-flight jobs
    if (this.activePromises.size > 0) {
      await Promise.allSettled(Array.from(this.activePromises));
    }

    // Clean up any remaining heartbeat timers
    for (const entry of this.activeJobs.values()) {
      if (entry.heartbeatTimer) {
        clearInterval(entry.heartbeatTimer);
      }
    }
    this.activeJobs.clear();

    this.emit("closed");
  }

  private wakeUp(): void {
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }
    if (this.pollResolve) {
      const resolve = this.pollResolve;
      this.pollResolve = undefined;
      resolve();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pollResolve = resolve;
      this.pollTimeout = setTimeout(() => {
        this.pollTimeout = undefined;
        this.pollResolve = undefined;
        resolve();
      }, ms);
      this.pollTimeout.unref?.();
    });
  }

  private async dispatchLoop(): Promise<void> {
    while (this.isRunning) {
      if (this.isPaused) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      // Check available capacity
      const availableSlots = this.concurrency - this.activeJobs.size;
      if (availableSlots <= 0) {
        // All worker slots are busy; wait for a slot to free up
        await this.sleep(50);
        continue;
      }

      let poppedAny = false;

      // Fill available slots
      for (let i = 0; i < availableSlots; i++) {
        if (!this.isRunning || this.isPaused) break;

        let job: Job<Payload, Result> | undefined;
        try {
          job = await this.queue.pop({ visibilityTimeoutMs: this.visibilityTimeoutMs });
        } catch (err) {
          if (this.isRunning && this.listenerCount("error") > 0) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
          }
          break;
        }

        if (!job) {
          // No ready job at this moment
          break;
        }

        poppedAny = true;
        this.spawnJob(job);
      }

      if (!poppedAny && this.activeJobs.size === 0) {
        this.emit("drained");
      }

      if (!poppedAny) {
        // Nothing was ready to pop, back off for pollIntervalMs
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private spawnJob(job: Job<Payload, Result>): void {
    const jobEntry: { job: Job<Payload, Result>; heartbeatTimer?: NodeJS.Timeout } = { job };

    if (this.autoHeartbeat && job.lockToken) {
      const interval = Math.max(500, Math.floor(this.visibilityTimeoutMs / 2));
      jobEntry.heartbeatTimer = setInterval(() => {
        void this.queue.heartbeat(job.id, job.lockToken!, this.visibilityTimeoutMs).catch(() => {});
      }, interval);
      jobEntry.heartbeatTimer.unref?.();
    }

    this.activeJobs.set(job.id, jobEntry);

    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const result = await this.processor(job);
        if (jobEntry.heartbeatTimer) {
          clearInterval(jobEntry.heartbeatTimer);
          jobEntry.heartbeatTimer = undefined;
        }

        if (job.lockToken) {
          await this.queue.ack(job.id, job.lockToken, result);
        }
        this.emit("completed", job, result);
      } catch (err) {
        if (jobEntry.heartbeatTimer) {
          clearInterval(jobEntry.heartbeatTimer);
          jobEntry.heartbeatTimer = undefined;
        }

        const errorObj = err instanceof Error ? err : new Error(String(err));
        try {
          if (job.lockToken) {
            await this.queue.nack(job.id, job.lockToken, errorObj);
          }
        } catch (nackErr) {
          if (this.isRunning && this.listenerCount("error") > 0) {
            this.emit("error", nackErr instanceof Error ? nackErr : new Error(String(nackErr)));
          }
        }
        this.emit("failed", job, errorObj);
      } finally {
        this.activeJobs.delete(job.id);
        this.activePromises.delete(promise);
        // Wake up dispatch loop to immediately pull next job for the freed slot
        this.wakeUp();
      }
    })();

    this.activePromises.add(promise);
  }
}
