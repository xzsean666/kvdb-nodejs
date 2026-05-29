// Canonical JSON (de)serialization (docs/ARCHITECTURE.md KD-3).
//
// Values are stored as canonical text JSON: object keys are sorted so identical
// values always produce identical text. That determinism is what makes query
// cache keys and decorator keys stable (see decorators/cache-key.ts).
//
// This is the single layer that turns values into storage text and back. It
// rejects values JSON cannot represent (cycles, NaN/Infinity) with an explicit
// KvdbSerializationError rather than producing silently-wrong output.

import type { JsonValue } from "../types/json.js";
import { KvdbSerializationError } from "./errors.js";

/**
 * Serialize a value to canonical JSON text.
 * - Object keys are sorted (deterministic output).
 * - `undefined` object properties are dropped (JSON semantics).
 * - Cycles, functions, symbols, and non-finite numbers throw.
 */
export function serialize(value: unknown): string {
  return canonicalize(value, new WeakSet(), "$");
}

/** Parse canonical JSON text back into a value. */
export function deserialize<T = JsonValue>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new KvdbSerializationError("Failed to parse stored JSON", { cause });
  }
}

/**
 * Stable string form of an arbitrary value, used for cache/query keys.
 * Same rules as `serialize`, but tolerant of `undefined` at the top level
 * (encoded as the literal "undefined") so it can key method arguments.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  return canonicalize(value, new WeakSet(), "$");
}

function canonicalize(value: unknown, seen: WeakSet<object>, path: string): string {
  if (value === null) return "null";

  const valueType = typeof value;

  if (valueType === "string") return JSON.stringify(value);
  if (valueType === "boolean") return value ? "true" : "false";
  if (valueType === "number") {
    if (!Number.isFinite(value as number)) {
      throw new KvdbSerializationError(
        `Non-finite number is not JSON-serializable at ${path}`,
      );
    }
    return JSON.stringify(value);
  }
  if (valueType === "bigint") {
    throw new KvdbSerializationError(`BigInt is not JSON-serializable at ${path}`);
  }
  if (valueType === "function" || valueType === "symbol") {
    throw new KvdbSerializationError(
      `${valueType} is not JSON-serializable at ${path}`,
    );
  }

  // Objects and arrays.
  const object = value as object;
  if (seen.has(object)) {
    throw new KvdbSerializationError(`Circular reference detected at ${path}`);
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.map((item, index) =>
        // JSON renders `undefined` array slots as null.
        item === undefined ? "null" : canonicalize(item, seen, `${path}[${index}]`),
      );
      return `[${items.join(",")}]`;
    }

    // Respect a custom toJSON (Date, etc.) before treating as a plain object.
    const maybeToJson = (object as { toJSON?: () => unknown }).toJSON;
    if (typeof maybeToJson === "function") {
      return canonicalize(maybeToJson.call(object), seen, path);
    }

    const entries = Object.keys(object as Record<string, unknown>)
      .sort()
      .map((key) => [key, (object as Record<string, unknown>)[key]] as const)
      .filter(([, propertyValue]) => propertyValue !== undefined)
      .map(
        ([key, propertyValue]) =>
          `${JSON.stringify(key)}:${canonicalize(propertyValue, seen, `${path}.${key}`)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}
