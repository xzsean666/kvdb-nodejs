// Chunked Blob Storage implementation (docs/SPEC.md §25)
import type { Table } from "../core/table.js";
import type { BlobMeta, BlobOptions } from "./types.js";

const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KB

export class BlobStorage {
  /**
   * Slice and write a large data payload into chunked storage.
   */
  static async putBlob(
    table: Table<any>,
    key: string,
    data: Buffer | Uint8Array | string,
    options: BlobOptions = {},
  ): Promise<BlobMeta> {
    const buffer = typeof data === "string"
      ? Buffer.from(data, "utf8")
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    const chunkSize = options.chunkSize && options.chunkSize > 0
      ? options.chunkSize
      : DEFAULT_CHUNK_SIZE;

    const totalChunks = buffer.length === 0 ? 1 : Math.ceil(buffer.length / chunkSize);
    const now = Date.now();

    const meta: BlobMeta = {
      key,
      size: buffer.length,
      chunkSize,
      totalChunks,
      contentType: options.contentType,
      createdAt: now,
    };

    const ttlMs = options.ttlMs;

    // 1. Write all chunk slices
    const chunkPromises: Promise<void>[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, buffer.length);
      const slice = buffer.subarray(start, end);
      const chunkBase64 = slice.toString("base64");
      chunkPromises.push(
        table.set(`_blob:${key}:chunk:${i}`, chunkBase64, { ttlMs }),
      );
    }
    await Promise.all(chunkPromises);

    // 2. Write metadata manifest
    await table.set(`_blob:${key}:meta`, meta, { ttlMs });

    return meta;
  }

  /**
   * Retrieve and reassemble all chunks into a complete Buffer.
   */
  static async getBlob(
    table: Table<any>,
    key: string,
  ): Promise<Buffer | undefined> {
    const meta = await this.getBlobMeta(table, key);
    if (!meta) return undefined;

    if (meta.size === 0) {
      return Buffer.alloc(0);
    }

    const chunkKeys = Array.from(
      { length: meta.totalChunks },
      (_, i) => `_blob:${key}:chunk:${i}`,
    );

    const chunks = await table.getMany(chunkKeys);
    const buffers: Buffer[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkRaw = chunks[i];
      if (typeof chunkRaw !== "string") {
        // Missing chunk: partial corruption or expired
        return undefined;
      }
      buffers.push(Buffer.from(chunkRaw, "base64"));
    }

    return Buffer.concat(buffers);
  }

  /**
   * Read the metadata manifest of a blob.
   */
  static async getBlobMeta(
    table: Table<any>,
    key: string,
  ): Promise<BlobMeta | undefined> {
    return (await table.get(`_blob:${key}:meta`)) as BlobMeta | undefined;
  }

  /**
   * Delete a blob, including all its chunk slices and metadata manifest.
   */
  static async deleteBlob(
    table: Table<any>,
    key: string,
  ): Promise<boolean> {
    const meta = await this.getBlobMeta(table, key);
    if (!meta) return false;

    const chunkKeys = Array.from(
      { length: meta.totalChunks },
      (_, i) => `_blob:${key}:chunk:${i}`,
    );

    await Promise.all([
      table.deleteMany(chunkKeys),
      table.delete(`_blob:${key}:meta`),
    ]);

    return true;
  }
}
