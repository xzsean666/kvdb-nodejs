// Observability & Metrics types (docs/SPEC.md §26)

export interface LatencyPercentiles {
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface DatabaseMetrics {
  readonly reads: number;
  readonly writes: number;
  readonly deletes: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheHitRatio: number;
  readonly latency: LatencyPercentiles;
  readonly locksAcquired: number;
  readonly locksContended: number;
  readonly uptimeSeconds: number;
}

export type MetricEventType = "read" | "write" | "delete" | "lock";

export interface MetricEvent {
  type: MetricEventType;
  key?: string;
  durationMs: number;
  success: boolean;
}

export type MetricHook = (event: MetricEvent) => void;
