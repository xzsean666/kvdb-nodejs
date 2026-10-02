// In-memory query AST evaluator.
//
// Allows backends without native JSON query engines (e.g., Redis, in-memory stores)
// to execute compiled QueryNode ASTs with 100% semantic fidelity.

import type { QueryNode, FieldPath, SortSpec } from "./ast.js";
import type { JsonValue } from "../types/json.js";

export function evaluateQuery(node: QueryNode, doc: unknown): boolean {
  switch (node.kind) {
    case "true":
      return true;
    case "and":
      return node.children.every((child) => evaluateQuery(child, doc));
    case "or":
      return node.children.some((child) => evaluateQuery(child, doc));
    case "nor":
      return !node.children.some((child) => evaluateQuery(child, doc));
    case "not":
      return !evaluateQuery(node.child, doc);
    case "exists": {
      const { exists } = extractValue(doc, node.path);
      return exists === node.value;
    }
    case "cmp": {
      const { exists, value: actual } = extractValue(doc, node.path);
      return evaluateCompare(node.op, actual, exists, node.value);
    }
    case "elemMatch": {
      const { exists, value: actual } = extractValue(doc, node.path);
      if (!exists || !Array.isArray(actual)) return false;
      return actual.some((elem) => evaluateQuery(node.child, elem));
    }
  }
}

export function sortDocuments<T extends { value: unknown }>(
  items: T[],
  sortSpecs?: SortSpec[],
): T[] {
  if (!sortSpecs || sortSpecs.length === 0) return items;
  return items.slice().sort((a, b) => {
    for (const spec of sortSpecs) {
      const valA = extractValue(a.value, spec.path).value;
      const valB = extractValue(b.value, spec.path).value;
      const cmp = compareValues(valA, valB);
      if (cmp !== 0) {
        return spec.direction === "asc" ? cmp : -cmp;
      }
    }
    return 0;
  });
}

function extractValue(
  doc: unknown,
  path: FieldPath,
): { exists: boolean; value: unknown } {
  let curr = doc;
  if (path.sourceKind === "column") {
    if (curr === null || typeof curr !== "object" || !Object.prototype.hasOwnProperty.call(curr, path.source)) {
      return { exists: false, value: undefined };
    }
    curr = (curr as Record<string, unknown>)[path.source];
  }
  for (const seg of path.segments) {
    if (curr === null || typeof curr !== "object") {
      return { exists: false, value: undefined };
    }
    if ("key" in seg) {
      if (!Object.prototype.hasOwnProperty.call(curr, seg.key)) {
        return { exists: false, value: undefined };
      }
      curr = (curr as Record<string, unknown>)[seg.key];
    } else if ("index" in seg) {
      if (!Array.isArray(curr)) {
        return { exists: false, value: undefined };
      }
      const idx = seg.index < 0 ? curr.length + seg.index : seg.index;
      if (idx < 0 || idx >= curr.length) {
        return { exists: false, value: undefined };
      }
      curr = curr[idx];
    }
  }
  return { exists: true, value: curr };
}

function evaluateCompare(
  op: string,
  actual: unknown,
  exists: boolean,
  target: JsonValue,
): boolean {
  switch (op) {
    case "$eq":
      if (!exists) return target === null || target === undefined;
      return isEqual(actual, target);
    case "$ne":
      if (!exists) return target !== undefined;
      return !isEqual(actual, target);
    case "$gt":
      return exists && typeof actual === "number" && typeof target === "number" && actual > target;
    case "$gte":
      return exists && typeof actual === "number" && typeof target === "number" && actual >= target;
    case "$lt":
      return exists && typeof actual === "number" && typeof target === "number" && actual < target;
    case "$lte":
      return exists && typeof actual === "number" && typeof target === "number" && actual <= target;
    case "$in":
      if (!Array.isArray(target)) return false;
      if (!exists) return target.includes(null) || target.includes(undefined as any);
      return target.some((val) => isEqual(actual, val));
    case "$nin":
      if (!Array.isArray(target)) return true;
      if (!exists) return !target.includes(null) && !target.includes(undefined as any);
      return !target.some((val) => isEqual(actual, val));
    default:
      return false;
  }
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!isEqual(objA[k], objB[k])) return false;
  }
  return true;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b));
}
