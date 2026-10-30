// Chunked Blob Storage types (docs/SPEC.md §25)

export interface BlobMeta {
  readonly key: string;
  readonly size: number;
  readonly chunkSize: number;
  readonly totalChunks: number;
  readonly contentType?: string;
  readonly createdAt: number;
}

export interface BlobOptions {
  /**
   * Slice chunk size in bytes. Default: 262,144 (256KB).
   */
  chunkSize?: number;

  /**
   * MIME content type (e.g. "application/pdf", "image/png").
   */
  contentType?: string;

  /**
   * Optional TTL for the blob in milliseconds.
   */
  ttlMs?: number;
}
