// Auto-index manager (docs/ARCHITECTURE.md §6, opt-in).
//
// Counts how often each JSON path is queried. When a path crosses the threshold,
// it is returned once (and only once) so the caller can create an index for it.
// This is OFF by default: issuing DDL implicitly is surprising, so it must be
// explicitly enabled via KVDBOptions.autoIndex.

export class AutoIndexManager {
  private readonly counts = new Map<string, number>();
  private readonly indexed = new Set<string>();

  constructor(private readonly threshold: number) {}

  /**
   * Record that `paths` were queried. Returns the subset that just reached the
   * threshold and should now be indexed (each path is returned at most once).
   */
  record(paths: string[]): string[] {
    const toIndex: string[] = [];
    for (const path of paths) {
      if (this.indexed.has(path)) continue;
      const next = (this.counts.get(path) ?? 0) + 1;
      this.counts.set(path, next);
      if (next >= this.threshold) {
        this.indexed.add(path);
        this.counts.delete(path);
        toIndex.push(path);
      }
    }
    return toIndex;
  }
}
