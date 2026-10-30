// Schedule types (docs/SPEC.md §21)
import type { JobOptions } from "../queue/types.js";

export type CronOrInterval = string | { cron?: string; everyMs?: number };

export interface ScheduleOptions extends JobOptions {
  /**
   * Optional custom identifier for the scheduled job. Defaults to job name.
   */
  jobId?: string;
}

export interface ScheduledJob<Payload = unknown> {
  readonly name: string;
  readonly queue: string;
  readonly cron?: string;
  readonly everyMs?: number;
  readonly payload: Payload;
  readonly options?: ScheduleOptions;
  readonly nextRunAt: number;
  readonly createdAt: number;
}
