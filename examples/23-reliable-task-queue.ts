// 23-reliable-task-queue.ts — Reliable, zero-dependency, crash-resilient task queue
//
// Demonstrates:
// 1. Pushing individual & batch jobs with priorities and retry backoff.
// 2. Multi-slot concurrent Worker processing with automatic ack/nack.
// 3. Graceful shutdown waiting for in-flight tasks to complete.
//
// Run:  pnpm example 23-reliable-task-queue.ts

import { KVDB } from "../src/index.js";

interface EmailTask {
  to: string;
  subject: string;
  type: "welcome" | "receipt" | "digest";
}

interface EmailResult {
  messageId: string;
  deliveredAt: number;
}

async function main() {
  console.log("--- 1. Initializing KVDB and Reliable Task Queue ---");
  const db = new KVDB({ driver: "sqlite", url: ":memory:" });
  const queue = db.queue<EmailTask, EmailResult>("outbound-emails", {
    defaultVisibilityTimeoutMs: 10_000,
    defaultMaxAttempts: 3,
  });

  console.log("--- 2. Enqueuing Email Tasks with Priorities ---");
  // Enqueue regular digest emails
  await queue.pushMany([
    { payload: { to: "user1@example.com", subject: "Weekly Newsletter", type: "digest" }, options: { priority: 10 } },
    { payload: { to: "user2@example.com", subject: "Weekly Newsletter", type: "digest" }, options: { priority: 10 } },
  ]);

  // Enqueue urgent payment receipt (priority -1)
  await queue.push(
    { to: "customer@example.com", subject: "Order #9821 Receipt", type: "receipt" },
    { priority: -1 },
  );

  // Enqueue welcome email (priority 0)
  await queue.push(
    { to: "newbie@example.com", subject: "Welcome to KVDB!", type: "welcome" },
    { priority: 0 },
  );

  let stats = await queue.getStats();
  console.log(`Initial Queue Stats: waiting=${stats.waiting}, active=${stats.active}, total=${stats.total}`);

  console.log("--- 3. Starting Concurrent Worker (Concurrency = 2) ---");
  let failureInjected = false;

  const worker = db.worker<EmailTask, EmailResult>(
    queue,
    async (job) => {
      console.log(`  [Worker] Picked up job "${job.id}" (Type: ${job.payload.type}, Priority: ${job.priority}, Attempt: ${job.attempts})`);

      // Inject a one-time transient network failure for newsletter to demonstrate backoff retry
      if (job.payload.type === "digest" && !failureInjected) {
        failureInjected = true;
        console.log(`  [Worker] Simulating transient network failure for "${job.payload.subject}"...`);
        throw new Error("SMTP connection timeout");
      }

      // Simulate sending latency
      await new Promise((r) => setTimeout(r, 60));

      console.log(`  [Worker] Successfully delivered email to ${job.payload.to}`);
      return {
        messageId: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        deliveredAt: Date.now(),
      };
    },
    { concurrency: 2, pollIntervalMs: 50 },
  );

  worker.on("completed", (job, res) => {
    console.log(`  [Event] Job completed: id=${job.id}, messageId=${res.messageId}`);
  });

  worker.on("failed", (job, err) => {
    console.log(`  [Event] Job failed (will retry): id=${job.id}, error="${err.message}"`);
  });

  worker.start();

  // Wait for jobs to settle
  await new Promise<void>((resolve) => {
    const check = setInterval(async () => {
      const s = await queue.getStats();
      if (s.completed >= 4 || (s.completed === 3 && s.delayed === 1)) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  stats = await queue.getStats();
  console.log(`--- 4. Current Queue Stats: completed=${stats.completed}, delayed=${stats.delayed}, failed=${stats.failed} ---`);

  console.log("--- 5. Gracefully Shutting Down Worker ---");
  await worker.close();
  await db.close();
  console.log("Worker and KVDB shut down cleanly. Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
