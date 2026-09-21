// Auto-index manager (docs/ARCHITECTURE.md §6, opt-in).
//
// Counts how often each JSON path is queried. When a path crosses the threshold,
// it is returned once (and only once) so the caller can create an index for it.
// This is OFF by default: issuing DDL implicitly is surprising, so it must be
// explicitly enabled via KVDBOptions.autoIndex.

export class AutoIndexManager {
  private readonly counts = new Map<string, number>();
  private readonly indexed = new Set<string>();

  constructor(
    private readonly threshold: number,
    private readonly maxTracked: number = 10_000,
    private readonly maxIndexed: number = 200,
  ) {}

  /**
   * Record that `paths` were queried. Returns the subset that just reached the
   * threshold and should now be indexed (each path is returned at most once).
   */
  record(paths: string[]): string[] {
    const toIndex: string[] = [];
    for (const path of paths) {
      if (this.indexed.has(path)) continue;
      if (this.indexed.size >= this.maxIndexed) continue;
      const next = (this.counts.get(path) ?? 0) + 1;
      this.counts.set(path, next);
      if (next >= this.threshold) {
        this.indexed.add(path);
        this.counts.delete(path);
        toIndex.push(path);
      }
    }


    if (this.counts.size > this.maxTracked) {
      const excess = this.counts.size - this.maxTracked;
      const iterator = this.counts.keys();
      for (let i = 0; i < excess; i++) {
        const nextKey = iterator.next().value;
        if (nextKey !== undefined) {
          this.counts.delete(nextKey);
        } else {
          break;
        }
      }
    }

    return toIndex;
  }
}
