// AST -> MongoDB query compiler (docs/ARCHITECTURE.md KD-2).
//
// MongoDB is not SQL, so it does not use the shared SqlDialect; instead the same
// backend-agnostic QueryNode AST is lowered to a native Mongo filter object. The
// AST maps almost 1:1 to Mongo operators — the main work is prefixing stored
// fields (we keep the queryable document under `doc`) and translating the AST's
// expression-level `not` into a top-level `$nor`.

import type { QueryNode, FieldPath, SortSpec } from "../../query/ast.js";
import type { JsonValue } from "../../types/json.js";

/** The queryable copy of each value lives under this field (see the driver). */
const FIELD_PREFIX = "doc.";

export function compileMongoFilter(node: QueryNode): Record<string, unknown> {
  return compile(node, FIELD_PREFIX);
}

export function compileMongoSort(sort: SortSpec[]): Record<string, 1 | -1> {
  const result: Record<string, 1 | -1> = {};
  for (const spec of sort) {
    result[resolveField(spec.path, FIELD_PREFIX)] = spec.direction === "desc" ? -1 : 1;
  }
  return result;
}

function compile(node: QueryNode, prefix: string): Record<string, unknown> {
  switch (node.kind) {
    case "true":
      return {};
    case "and":
      return { $and: node.children.map((child) => compile(child, prefix)) };
    case "or":
      return { $or: node.children.map((child) => compile(child, prefix)) };
    case "nor":
      return { $nor: node.children.map((child) => compile(child, prefix)) };
    case "not":
      return { $nor: [compile(node.child, prefix)] };
    case "cmp":
      return compileCompare(node.op, resolveField(node.path, prefix), node.value);
    case "exists":
      return { [resolveField(node.path, prefix)]: { $exists: node.value } };
    case "elemMatch":
      // Inner conditions are relative to the array element (no field prefix).
      return { [resolveField(node.path, prefix)]: { $elemMatch: compile(node.child, "") } };
  }
}

function resolveField(path: FieldPath, prefix: string): string {
  if (path.sourceKind === "column") {
    if (path.segments.length === 0) return path.source;
    return `${path.source}.${renderPath(path)}`;
  }
  return prefix + renderPath(path);
}

function compileCompare(op: string, field: string, value: JsonValue): Record<string, unknown> {
  // $eq is expressed as a bare equality; the rest map directly to Mongo operators.
  return op === "$eq" ? { [field]: value } : { [field]: { [op]: value } };
}

/** Render a FieldPath as a Mongo dotted path (array indices are dotted too). */
function renderPath(path: FieldPath): string {
  return path.segments
    .map((segment) => ("index" in segment ? String(segment.index) : segment.key))
    .join(".");
}

