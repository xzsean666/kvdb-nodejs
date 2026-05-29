// Canonical JSON value types shared across the SDK.
//
// All values stored in KVDB are JSON-serializable. We model that explicitly here
// so every module agrees on the same value domain (see docs/ARCHITECTURE.md KD-3).

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** A value that may be returned synchronously or as a Promise. */
export type MaybePromise<T> = T | Promise<T>;
