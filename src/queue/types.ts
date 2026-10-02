// Types and contracts for the reliable Queue subsystem (docs/AI/tasks/TASK-028-QUEUE.md).

export type JobState = "waiting" | "active" | "delayed" | "completed" | "failed";

export interface BackoffOptions {
  type: "fixed" | "exponential";
  delayMs: number;
}

export interface JobOptions {
  /** Delay before the job becomes eligible for processing (ms). */
  delayMs?: number;
  /** Numerical priority (lower number = higher priority, default: 0). */
  priority?: number;
  /** Maximum number of processing attempts before moving to failed (default: 3). */
  maxAttempts?: number;
  /** Retry backoff strategy on failure. */
  backoff?: BackoffOptions;
  /** Unique job ID. If not provided, a random UUID is generated. */
  jobId?: string;
  /** If true, the job record is removed from the table upon successful completion. */
  removeOnComplete?: boolean;
}

export interface JobData<Payload = unknown, Result = unknown> {
  id: string;
  payload: Payload;
  result?: Result;
  error?: string;
  stack?: string;
  backoff?: BackoffOptions;
  removeOnComplete?: boolean;
}

export interface Job<Payload = unknown, Result = unknown> {
  id: string;
  state: JobState;
  priority: number;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  lockToken?: string;
  lockExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  payload: Payload;
  result?: Result;
  error?: string;
}

export interface QueueOptions {
  /** Default visibility timeout / lease duration for popped jobs (default: 30,000ms). */
  defaultVisibilityTimeoutMs?: number;
  /** Default max processing attempts before moving to failed (default: 3). */
  defaultMaxAttempts?: number;
  /** Default retry backoff strategy. */
  defaultBackoff?: BackoffOptions;
}

export interface WorkerOptions {
  /** Number of concurrent jobs this worker can process simultaneously (default: 1). */
  concurrency?: number;
  /** Polling interval (ms) when no jobs are available in queue (default: 1000ms). */
  pollIntervalMs?: number;
  /** Lease duration (ms) granted when popping a job (default: 30,000ms). */
  visibilityTimeoutMs?: number;
  /** Whether to automatically heartbeat and extend active job lease in background (default: true). */
  autoHeartbeat?: boolean;
}

export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  total: number;
}

export type JobProcessor<Payload = unknown, Result = unknown> = (
  job: Job<Payload, Result>,
) => Promise<Result> | Result;
