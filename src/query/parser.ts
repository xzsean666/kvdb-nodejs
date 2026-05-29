// Query parser — Mongo-style query document -> backend-agnostic AST.
//
// This is the ONLY place that interprets the user's query shape. Backends never
// see the raw document; they receive a QueryNode (query/ast.ts) and lower it.
//
// Supported (v1, see docs/SPEC.md §6.2):
//   field: value                      -> $eq
//   field: { $gt: x, $lte: y, ... }   -> AND of comparisons
//   field: { $exists: true|false }    -> exists
//   field: { $elemMatch: { ... } }    -> elemMatch
//   $and/$or/$nor: [ {...}, {...} ]   -> logical
//   $not: { ...sub-where }            -> negation
//
// Dotted paths address nested objects; a purely-numeric segment is an array index.

import type {
  CompareOp,
  FieldPath,
  PathSegment,
  QueryNode,
  FindOptions,
  SortSpec,
} from "./ast.js";
import type { JsonValue } from "../types/json.js";
import { KvdbQueryError } from "../core/errors.js";

const COMPARE_OPS: ReadonlySet<string> = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
]);

/** Parse a dotted path string into a FieldPath. */
export function parsePath(source: string): FieldPath {
  if (source.length === 0) {
    throw new KvdbQueryError("Empty field path");
  }
  const segments: PathSegment[] = source.split(".").map((part) => {
    if (part.length === 0) {
      throw new KvdbQueryError(`Empty segment in path "${source}"`);
    }
    return /^\d+$/.test(part) ? { index: Number(part) } : { key: part };
  });
  return { segments, source };
}

/** Parse a `where` document into a QueryNode. */
export function parseWhere(where: Record<string, unknown> | undefined): QueryNode {
  if (where === undefined || Object.keys(where).length === 0) {
    return { kind: "true" };
  }
  const children = Object.entries(where).map(([key, value]) => parseEntry(key, value));
  return children.length === 1 ? children[0]! : { kind: "and", children };
}

function parseEntry(key: string, value: unknown): QueryNode {
  switch (key) {
    case "$and":
      return { kind: "and", children: parseBranchList(key, value) };
    case "$or":
      return { kind: "or", children: parseBranchList(key, value) };
    case "$nor":
      return { kind: "nor", children: parseBranchList(key, value) };
    case "$not":
      return { kind: "not", child: parseWhere(asObject(key, value)) };
    default:
      if (key.startsWith("$")) {
        throw new KvdbQueryError(`Unknown top-level operator "${key}"`);
      }
      return parseField(parsePath(key), value);
  }
}

function parseField(path: FieldPath, value: unknown): QueryNode {
  // A plain value (not an operator object) is an equality match.
  if (!isOperatorObject(value)) {
    return { kind: "cmp", op: "$eq", path, value: value as JsonValue };
  }

  const conditions: QueryNode[] = [];
  for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
    if (COMPARE_OPS.has(op)) {
      conditions.push({ kind: "cmp", op: op as CompareOp, path, value: operand as JsonValue });
    } else if (op === "$exists") {
      if (typeof operand !== "boolean") {
        throw new KvdbQueryError(`$exists expects a boolean at "${path.source}"`);
      }
      conditions.push({ kind: "exists", path, value: operand });
    } else if (op === "$elemMatch") {
      conditions.push({
        kind: "elemMatch",
        path,
        child: parseWhere(asObject(op, operand)),
      });
    } else {
      throw new KvdbQueryError(`Unknown operator "${op}" at "${path.source}"`);
    }
  }
  return conditions.length === 1 ? conditions[0]! : { kind: "and", children: conditions };
}

/** An object whose keys are all operators ($-prefixed). A plain object value is $eq. */
function isOperatorObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

function parseBranchList(op: string, value: unknown): QueryNode[] {
  if (!Array.isArray(value)) {
    throw new KvdbQueryError(`${op} expects an array`);
  }
  return value.map((branch) => parseWhere(asObject(op, branch)));
}

function asObject(op: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KvdbQueryError(`${op} expects an object`);
  }
  return value as Record<string, unknown>;
}

/** Parse sort specs from the user query into AST SortSpecs. */
export function parseSort(
  sort: { path: string; direction?: "asc" | "desc" }[] | undefined,
): SortSpec[] | undefined {
  if (sort === undefined) return undefined;
  return sort.map((spec) => ({
    path: parsePath(spec.path),
    direction: spec.direction ?? "asc",
  }));
}

/** Build FindOptions from the user-facing query document. */
export function parseFindOptions(query: {
  limit?: number;
  offset?: number;
  sort?: { path: string; direction?: "asc" | "desc" }[];
}): FindOptions {
  return {
    limit: query.limit,
    offset: query.offset,
    sort: parseSort(query.sort),
  };
}
