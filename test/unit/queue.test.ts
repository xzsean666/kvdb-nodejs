import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { Queue } from "../../src/queue/queue.js";
import { Worker } from "../../src/queue/worker.js";
import { KvdbQueueError } from "../../src/core/errors.js";

describe("Reliable Queue Subsystem (TASK-028-QUEUE)", () => {
  let db: KVDB;

  beforeEach(() => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Queue Operations", () => {
    it("pushes single and batch jobs, accurately reporting queue stats", async () => {
      const queue = db.queue<{ text: string }, { done: boolean }>("test-basic");

      const job1 = await queue.push({ text: "first" });
      expect(job1.id).toBeDefined();
      expect(job1.state).toBe("waiting");
      expect(job1.payload.text).toBe("first");

      const batch = await queue.pushMany([
        { payload: { text: "second" } },
        { payload: { text: "third" } },
      ]);
      expect(batch).toHaveLength(2);
      expect(batch[0]!.payload.text).toBe("second");
      expect(batch[1]!.payload.text).toBe("third");

      const stats = await queue.getStats();
      expect(stats.waiting).toBe(3);
      expect(stats.total).toBe(3);
      expect(stats.active).toBe(0);
    });

    it("respects priority and FIFO ordering on pop", async () => {
      const queue = db.queue<{ name: string }>("test-priority");

      // Push low, high, medium priority
      await queue.push({ name: "normal-1" }, { priority: 0 });
      await queue.push({ name: "urgent" }, { priority: -10 });
      await queue.push({ name: "low" }, { priority: 10 });
      await queue.push({ name: "normal-2" }, { priority: 0 });

      // First popped must be the highest priority (lowest numerical value: -10)
      const pop1 = await queue.pop();
      expect(pop1?.payload.name).toBe("urgent");
      expect(pop1?.state).toBe("active");
      expect(pop1?.lockToken).toBeDefined();

      // Next should be normal-1 (FIFO between equal priority 0)
      const pop2 = await queue.pop();
      expect(pop2?.payload.name).toBe("normal-1");

      // Next should be normal-2
      const pop3 = await queue.pop();
      expect(pop3?.payload.name).toBe("normal-2");

      // Finally low priority (10)
      const pop4 = await queue.pop();
      expect(pop4?.payload.name).toBe("low");

      // Now queue should be empty of ready jobs
      const pop5 = await queue.pop();
      expect(pop5).toBeUndefined();
    });

    it("prevents double consumption with atomic lease tokens and handles ack", async () => {
      const queue = db.queue<{ task: string }, string>("test-lease");
      await queue.push({ task: "render-video" });

      // Worker A claims the job
      const claimedA = await queue.pop({ visibilityTimeoutMs: 5000 });
      expect(claimedA).toBeDefined();
      expect(claimedA?.lockToken).toBeDefined();

      // Worker B immediately tries to pop — should find nothing because job is leased
      const claimedB = await queue.pop({ visibilityTimeoutMs: 5000 });
      expect(claimedB).toBeUndefined();

      // Acking with mismatching lock token must fail with KvdbQueueError
      await expect(
        queue.ack(claimedA!.id, "wrong-token", "ok"),
      ).rejects.toThrow(KvdbQueueError);

      // Acking with valid token marks completed
      const ackSuccess = await queue.ack(claimedA!.id, claimedA!.lockToken!, "video-rendered-url");
      expect(ackSuccess).toBe(true);

      const jobRecord = await queue.getJob(claimedA!.id);
      expect(jobRecord?.state).toBe("completed");
      expect(jobRecord?.result).toBe("video-rendered-url");

      const stats = await queue.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.active).toBe(0);
    });

    it("removes job on complete when removeOnComplete is configured", async () => {
      const queue = db.queue<{ data: string }>("test-remove-on-complete");
      const job = await queue.push({ data: "ephemeral" }, { removeOnComplete: true });

      const popped = await queue.pop();
      expect(popped).toBeDefined();
      await queue.ack(popped!.id, popped!.lockToken!, "done");

      const after = await queue.getJob(job.id);
      expect(after).toBeUndefined();

      const stats = await queue.getStats();
      expect(stats.total).toBe(0);
    });

    it("supports heartbeat to extend visibility lease for long-running jobs", async () => {
      const queue = db.queue<{ payload: string }>("test-heartbeat", {
        defaultVisibilityTimeoutMs: 5000,
      });
      await queue.push({ payload: "heavy-job" });

      const popped = await queue.pop();
      expect(popped).toBeDefined();
      const firstExpires = popped!.lockExpiresAt!;

      // Extend lease by 10,000ms
      const extended = await queue.heartbeat(popped!.id, popped!.lockToken!, 10_000);
      expect(extended).toBe(true);

      const refreshed = await queue.getJob(popped!.id);
      expect(refreshed?.lockExpiresAt).toBeGreaterThan(firstExpires);

      // Heartbeat with wrong token returns false
      const wrongToken = await queue.heartbeat(popped!.id, "fake-token", 10_000);
      expect(wrongToken).toBe(false);
    });

    it("performs exponential backoff retry on nack and transitions to failed upon reaching maxAttempts", async () => {
      const queue = db.queue<{ num: number }>("test-retry", {
        defaultMaxAttempts: 2,
        defaultBackoff: { type: "exponential", delayMs: 100 },
      });
      await queue.push({ num: 42 });

      // First attempt
      const attempt1 = await queue.pop();
      expect(attempt1).toBeDefined();
      expect(attempt1?.attempts).toBe(1);

      // Nack attempt 1 -> schedules retry (delayed)
      const retried1 = await queue.nack(attempt1!.id, attempt1!.lockToken!, "First crash");
      expect(retried1).toBe(true);

      let record = await queue.getJob(attempt1!.id);
      expect(record?.state).toBe("delayed");
      expect(record?.error).toBe("First crash");
      expect(record?.runAt).toBeGreaterThan(Date.now());

      // Attempting to pop immediately yields undefined because job is delayed
      const premature = await queue.pop();
      expect(premature).toBeUndefined();

      // Fast-forward runAt to simulate delay elapsed
      const table = (queue as any).table;
      await table.update(attempt1!.id, (c: any) => c, { keys: { runAt: Date.now() - 1000 } });

      // Second attempt
      const attempt2 = await queue.pop();
      expect(attempt2).toBeDefined();
      expect(attempt2?.attempts).toBe(2);

      // Nack attempt 2 -> reaches maxAttempts (2), enters failed
      const retried2 = await queue.nack(attempt2!.id, attempt2!.lockToken!, new Error("Second crash"));
      expect(retried2).toBe(false); // No more retries

      record = await queue.getJob(attempt1!.id);
      expect(record?.state).toBe("failed");
      expect(record?.error).toBe("Second crash");

      const stats = await queue.getStats();
      expect(stats.failed).toBe(1);
    });

    it("recovers expired leases when worker crashes without acking or nacking", async () => {
      const queue = db.queue<{ msg: string }>("test-crash-recovery");
      await queue.push({ msg: "unhandled-crash" });

      const popped = await queue.pop({ visibilityTimeoutMs: 200 });
      expect(popped).toBeDefined();

      // Immediately, job is active and not claimable
      expect(await queue.pop()).toBeUndefined();

      // Simulate visibility timeout expiry
      const table = (queue as any).table;
      await table.update(popped!.id, (c: any) => c, {
        keys: { lockExpiresAt: Date.now() - 500 },
      });

      // Another worker polls — should re-claim the expired active job!
      const reclaimed = await queue.pop({ visibilityTimeoutMs: 5000 });
      expect(reclaimed).toBeDefined();
      expect(reclaimed?.id).toBe(popped!.id);
      expect(reclaimed?.attempts).toBe(2);
      expect(reclaimed?.lockToken).not.toBe(popped?.lockToken);
    });

    it("supports retryFailed to resurrect dead-letter jobs and clean to purge old records", async () => {
      const queue = db.queue<{ x: number }>("test-admin");
      await queue.push({ x: 1 }, { maxAttempts: 1 });

      const popped = await queue.pop();
      await queue.nack(popped!.id, popped!.lockToken!, "Permanent failure");

      let stats = await queue.getStats();
      expect(stats.failed).toBe(1);

      // Retry failed jobs
      const retriedCount = await queue.retryFailed();
      expect(retriedCount).toBe(1);

      stats = await queue.getStats();
      expect(stats.failed).toBe(0);
      expect(stats.waiting).toBe(1);

      // Complete it
      const poppedAgain = await queue.pop();
      await queue.ack(poppedAgain!.id, poppedAgain!.lockToken!);

      // Clean jobs older than 0ms
      const cleaned = await queue.clean({ olderThanMs: 0 });
      expect(cleaned).toBe(1);

      stats = await queue.getStats();
      expect(stats.total).toBe(0);
    });
  });

  describe("Worker & Concurrency", () => {
    it("processes jobs asynchronously with concurrency control and emits events", async () => {
      const queue = db.queue<{ index: number }, number>("test-worker-concurrency");
      const processed: number[] = [];

      for (let i = 1; i <= 6; i++) {
        await queue.push({ index: i });
      }

      const completedJobs: number[] = [];
      const worker = db.worker<typeof queue extends Queue<infer P, infer R> ? P : never, number>(
        queue,
        async (job) => {
          await new Promise((r) => setTimeout(r, 20));
          processed.push(job.payload.index);
          return job.payload.index * 10;
        },
        { concurrency: 3, pollIntervalMs: 50 },
      );

      worker.on("completed", (job, result) => {
        completedJobs.push(result);
      });

      worker.start();

      // Wait for all 6 jobs to complete
      await new Promise<void>((resolve) => {
        worker.on("drained", () => {
          if (completedJobs.length === 6) resolve();
        });
        const interval = setInterval(() => {
          if (completedJobs.length === 6) {
            clearInterval(interval);
            resolve();
          }
        }, 30);
      });

      expect(completedJobs).toHaveLength(6);
      expect(processed).toHaveLength(6);

      const stats = await queue.getStats();
      expect(stats.completed).toBe(6);
      expect(stats.active).toBe(0);

      await worker.close();
      expect(worker.running).toBe(false);
    });

    it("supports pause, resume, and graceful shutdown", async () => {
      const queue = db.queue<{ count: number }, string>("test-worker-lifecycle");
      await queue.push({ count: 1 });
      await queue.push({ count: 2 });

      let inFlight = 0;
      let maxConcurrentObserved = 0;

      const worker = new Worker(
        queue,
        async (_job) => {
          inFlight++;
          maxConcurrentObserved = Math.max(maxConcurrentObserved, inFlight);
          await new Promise((r) => setTimeout(r, 40));
          inFlight--;
          return "ok";
        },
        { concurrency: 1, pollIntervalMs: 50 },
      );

      worker.start();

      // Pause worker
      worker.pause();
      expect(worker.paused).toBe(true);

      // Resume worker
      worker.resume();
      expect(worker.paused).toBe(false);

      // Close gracefully — must wait for any in-flight execution
      await worker.close();
      expect(inFlight).toBe(0);
      expect(worker.running).toBe(false);
    });

    it("automatically closes registered workers when db.close() is invoked", async () => {
      const queue = db.queue<{ msg: string }>("test-kvdb-close");
      const worker = db.worker(queue, async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      worker.start();
      expect(worker.running).toBe(true);

      await db.close();
      expect(worker.running).toBe(false);
    });
  });
});
