// Observability & Metrics implementation (docs/SPEC.md §26)
import type {
  DatabaseMetrics,
  LatencyPercentiles,
  MetricEvent,
  MetricHook,
} from "./types.js";

const MAX_LATENCY_SAMPLES = 1000;

export class MetricsCollector {
  private readonly startedAt = Date.now();
  private reads = 0;
  private writes = 0;
  private deletes = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private locksAcquired = 0;
  private locksContended = 0;
  private readonly latencySamples: number[] = [];
  private readonly hooks = new Set<MetricHook>();

  recordRead(durationMs: number, success = true, key?: string): void {
    this.reads++;
    this.addSample(durationMs);
    this.emit({ type: "read", durationMs, success, key });
  }

  recordWrite(durationMs: number, success = true, key?: string): void {
    this.writes++;
    this.addSample(durationMs);
    this.emit({ type: "write", durationMs, success, key });
  }

  recordDelete(durationMs: number, success = true, key?: string): void {
    this.deletes++;
    this.addSample(durationMs);
    this.emit({ type: "delete", durationMs, success, key });
  }

  recordCache(hit: boolean): void {
    if (hit) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
    }
  }

  recordLock(acquired: boolean, contended: boolean): void {
    if (acquired) {
      this.locksAcquired++;
    }
    if (contended) {
      this.locksContended++;
    }
    this.emit({
      type: "lock",
      durationMs: 0,
      success: acquired,
    });
  }

  onMetric(hook: MetricHook): () => void {
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }

  getMetrics(): DatabaseMetrics {
    const totalCache = this.cacheHits + this.cacheMisses;
    const cacheHitRatio = totalCache === 0 ? 0 : Number((this.cacheHits / totalCache).toFixed(4));
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));

    return {
      reads: this.reads,
      writes: this.writes,
      deletes: this.deletes,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRatio,
      latency: this.calculateLatency(),
      locksAcquired: this.locksAcquired,
      locksContended: this.locksContended,
      uptimeSeconds,
    };
  }

  reset(): void {
    this.reads = 0;
    this.writes = 0;
    this.deletes = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.locksAcquired = 0;
    this.locksContended = 0;
    this.latencySamples.length = 0;
  }

  private addSample(durationMs: number): void {
    if (durationMs < 0) return;
    if (this.latencySamples.length >= MAX_LATENCY_SAMPLES) {
      this.latencySamples.shift();
    }
    this.latencySamples.push(durationMs);
  }

  private calculateLatency(): LatencyPercentiles {
    if (this.latencySamples.length === 0) {
      return { avgMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    }

    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avgMs = Number((sum / sorted.length).toFixed(3));

    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    const p99Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));

    const p95Ms = Number((sorted[p95Index] ?? 0).toFixed(3));
    const p99Ms = Number((sorted[p99Index] ?? 0).toFixed(3));
    const maxMs = Number((sorted[sorted.length - 1] ?? 0).toFixed(3));

    return { avgMs, p95Ms, p99Ms, maxMs };
  }

  private emit(event: MetricEvent): void {
    if (this.hooks.size === 0) return;
    for (const hook of this.hooks) {
      try {
        hook(event);
      } catch {}
    }
  }
}
