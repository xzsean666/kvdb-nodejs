import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KVDB } from "../../src/core/kvdb.js";

describe("Integration: persistent SQLite file-backed Queue (TASK-028-QUEUE)", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kvdb-queue-integration-"));
    file = join(dir, "queue.sqlite");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists jobs to disk and coordinates between two separate KVDB connections", async () => {
    const producerDb = new KVDB({ driver: "sqlite", url: file });
    const consumerDb = new KVDB({ driver: "sqlite", url: file });

    try {
      const producerQueue = producerDb.queue<{ email: string; orderId: number }, { sent: boolean }>("emails");
      const consumerQueue = consumerDb.queue<{ email: string; orderId: number }, { sent: boolean }>("emails");

      // Push 5 jobs on producer connection
      for (let i = 1; i <= 5; i++) {
        await producerQueue.push({ email: `user${i}@example.com`, orderId: 1000 + i });
      }

      expect(existsSync(file)).toBe(true);

      // Verify stats from consumer connection
      let stats = await consumerQueue.getStats();
      expect(stats.waiting).toBe(5);

      // Process 5 jobs using Worker on consumer connection
      const processed: number[] = [];
      const worker = consumerDb.worker(
        consumerQueue,
        async (job) => {
          processed.push(job.payload.orderId);
          return { sent: true };
        },
        { concurrency: 2, pollIntervalMs: 50 },
      );

      worker.start();

      await new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
          if (processed.length === 5) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      await worker.close();

      expect(processed).toHaveLength(5);
      stats = await producerQueue.getStats();
      expect(stats.completed).toBe(5);
      expect(stats.waiting).toBe(0);
    } finally {
      await producerDb.close();
      await consumerDb.close();
    }
  });

  it("recovers an in-flight job on disk when the processing node crashes without acking", async () => {
    const workerNode1 = new KVDB({ driver: "sqlite", url: file });
    const q1 = workerNode1.queue<{ action: string }>("crash-test");
    await q1.push({ action: "critical-sync" });

    // Worker 1 pops with 100ms visibility lease
    const leasedJob = await q1.pop({ visibilityTimeoutMs: 100 });
    expect(leasedJob).toBeDefined();
    expect(leasedJob?.state).toBe("active");

    // Worker 1 crashes (simulate abrupt close without ack or nack)
    await workerNode1.close();

    // Wait 150ms for the lease to expire
    await new Promise((r) => setTimeout(r, 150));

    // Worker Node 2 boots up, opens the database file
    const workerNode2 = new KVDB({ driver: "sqlite", url: file });
    try {
      const q2 = workerNode2.queue<{ action: string }>("crash-test");

      // Worker 2 polls — recovers expired lease automatically
      const recoveredJob = await q2.pop();
      expect(recoveredJob).toBeDefined();
      expect(recoveredJob?.id).toBe(leasedJob?.id);
      expect(recoveredJob?.attempts).toBe(2);

      // Successfully process and ack
      await q2.ack(recoveredJob!.id, recoveredJob!.lockToken!, "ok");

      const stats = await q2.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.active).toBe(0);
    } finally {
      await workerNode2.close();
    }
  });
});
