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

const MAX_SERIALIZE_DEPTH = 64;
const DANGEROUS_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function secureReviver(key: string, value: unknown): unknown {
  if (DANGEROUS_PROTO_KEYS.has(key)) {
    return undefined;
  }
  return value;
}

/**
 * Serialize a value to canonical JSON text.
 * - Object keys are sorted (deterministic output).
 * - `undefined` object properties are dropped (JSON semantics).
 * - Cycles, functions, symbols, and non-finite numbers throw.
 * - Max nesting depth is guarded against stack overflows.
 */
export function serialize(value: unknown): string {
  return canonicalize(value, new WeakSet(), []);
}

/** Parse canonical JSON text back into a value with prototype pollution protection. */
export function deserialize<T = JsonValue>(text: string): T {
  try {
    return JSON.parse(text, secureReviver) as T;
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
  return canonicalize(value, new WeakSet(), []);
}

function formatPath(pathStack: (string | number)[]): string {
  let str = "$";
  for (const seg of pathStack) {
    str += typeof seg === "number" ? `[${seg}]` : `.${seg}`;
  }
  return str;
}

function canonicalize(
  value: unknown,
  seen: WeakSet<object>,
  pathStack: (string | number)[],
): string {
  if (pathStack.length > MAX_SERIALIZE_DEPTH) {
    throw new KvdbSerializationError(`Maximum JSON depth of ${MAX_SERIALIZE_DEPTH} exceeded at ${formatPath(pathStack)}`);
  }
  if (value === null) return "null";

  const valueType = typeof value;

  if (valueType === "string") return JSON.stringify(value);
  if (valueType === "boolean") return value ? "true" : "false";
  if (valueType === "number") {
    if (!Number.isFinite(value as number)) {
      throw new KvdbSerializationError(
        `Non-finite number is not JSON-serializable at ${formatPath(pathStack)}`,
      );
    }
    return JSON.stringify(value);
  }
  if (valueType === "bigint") {
    throw new KvdbSerializationError(`BigInt is not JSON-serializable at ${formatPath(pathStack)}`);
  }
  if (valueType === "function" || valueType === "symbol") {
    throw new KvdbSerializationError(
      `${valueType} is not JSON-serializable at ${formatPath(pathStack)}`,
    );
  }

  // Objects and arrays.
  const object = value as object;
  if (seen.has(object)) {
    throw new KvdbSerializationError(`Circular reference detected at ${formatPath(pathStack)}`);
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      let arrayStr = "[";
      for (let i = 0; i < object.length; i++) {
        if (i > 0) arrayStr += ",";
        const item = object[i];
        if (item === undefined) {
          arrayStr += "null";
        } else {
          pathStack.push(i);
          arrayStr += canonicalize(item, seen, pathStack);
          pathStack.pop();
        }
      }
      return `${arrayStr}]`;
    }

    // Respect a custom toJSON (Date, etc.) before treating as a plain object.
    const maybeToJson = (object as { toJSON?: () => unknown }).toJSON;
    if (typeof maybeToJson === "function") {
      return canonicalize(maybeToJson.call(object), seen, pathStack);
    }

    const keys = Object.keys(object as Record<string, unknown>).sort();
    let objStr = "{";
    let first = true;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (DANGEROUS_PROTO_KEYS.has(k)) continue;
      const propertyValue = (object as Record<string, unknown>)[k];
      if (propertyValue !== undefined) {
        pathStack.push(k);
        const serializedProp = canonicalize(propertyValue, seen, pathStack);
        pathStack.pop();
        if (!first) objStr += ",";
        objStr += `${JSON.stringify(k)}:${serializedProp}`;
        first = false;
      }
    }
    return `${objStr}}`;
  } finally {
    seen.delete(object);
  }
}

