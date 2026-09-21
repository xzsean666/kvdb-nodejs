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

const VALID_PATH_SEGMENT = /^[A-Za-z0-9_$-]+$/;

/** Parse a dotted path string into a FieldPath. */
export function parsePath(source: string): FieldPath {
  if (source.length === 0) {
    throw new KvdbQueryError("Empty field path");
  }
  const segments: PathSegment[] = source.split(".").map((part) => {
    if (part.length === 0) {
      throw new KvdbQueryError(`Empty segment in path "${source}"`);
    }
    if (/^\d+$/.test(part)) {
      return { index: Number(part) };
    }
    if (!VALID_PATH_SEGMENT.test(part)) {
      throw new KvdbQueryError(`Invalid characters in field path segment "${part}"`);
    }
    return { key: part };
  });
  return { segments, source };
}

/** Parse a `where` document into a QueryNode. */
export function parseWhere(where: Record<string, unknown> | undefined): QueryNode {
  if (where === undefined || Object.keys(where).length === 0) {
    return { kind: "true" };
  }
  for (const key of Object.keys(where)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new KvdbQueryError(`Invalid query key "${key}": prototype pollution prevention`);
    }
  }
  const children = Object.entries(where).map(([key, value]) => parseEntry(key, value));
  return children.length === 1 ? children[0]! : { kind: "and", children };
}

import type { TableSchema, MultiKeySchema } from "../core/table-schema.js";

function extractKnownColumns(schema?: TableSchema | MultiKeySchema | Set<string>): Set<string> {
  if (!schema) return new Set();
  if (schema instanceof Set) return schema;
  const cols = new Set<string>();
  if (schema.primaryKey?.name) cols.add(schema.primaryKey.name);
  if (schema.keys) {
    for (const k of Object.keys(schema.keys)) cols.add(k);
  }
  if (schema.columns) {
    for (const k of Object.keys(schema.columns)) cols.add(k);
  }
  return cols;
}

export function parseSchemaWhere(
  where: Record<string, unknown> | undefined,
  knownSchema?: TableSchema | MultiKeySchema | Set<string>,
): QueryNode {
  if (!where || Object.keys(where).length === 0) return { kind: "true" };
  const knownCols = extractKnownColumns(knownSchema);
  return parseSchemaWhereNode(where, knownCols);
}

function parseSchemaWhereNode(where: Record<string, unknown>, knownCols: Set<string>): QueryNode {
  const parts: QueryNode[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new KvdbQueryError(`Invalid query key "${key}": prototype pollution prevention`);
    }
    switch (key) {

      case "$and":
        parts.push({ kind: "and", children: parseSchemaBranchList(key, value, knownCols) });
        break;
      case "$or":
        parts.push({ kind: "or", children: parseSchemaBranchList(key, value, knownCols) });
        break;
      case "$nor":
        parts.push({ kind: "nor", children: parseSchemaBranchList(key, value, knownCols) });
        break;
      case "$not":
        parts.push({ kind: "not", child: parseSchemaWhereNode(asObject(key, value), knownCols) });
        break;
      case "columns": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new KvdbQueryError("columns where expects an object");
        }
        const colNodes = Object.entries(value).map(([colKey, colVal]) => parseColumnField(colKey, colVal));
        if (colNodes.length) parts.push(colNodes.length === 1 ? colNodes[0]! : { kind: "and", children: colNodes });
        break;
      }
      case "value": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new KvdbQueryError("value where expects an object");
        }
        const valNodes = Object.entries(value).map(([valKey, valVal]) =>
          parseField({ ...parsePath(valKey), sourceKind: "value" }, valVal)
        );
        if (valNodes.length) parts.push(valNodes.length === 1 ? valNodes[0]! : { kind: "and", children: valNodes });
        break;
      }
      default: {
        if (key.startsWith("$")) {
          throw new KvdbQueryError(`Unknown top-level operator "${key}"`);
        }
        const root = key.split(".")[0]!;
        if (knownCols.has(root)) {
          parts.push(parseColumnField(key, value));
        } else {
          parts.push(parseField({ ...parsePath(key), sourceKind: "value" }, value));
        }
        break;
      }
    }
  }
  return parts.length === 0 ? { kind: "true" } : parts.length === 1 ? parts[0]! : { kind: "and", children: parts };
}

function parseSchemaBranchList(op: string, value: unknown, knownCols: Set<string>): QueryNode[] {
  if (!Array.isArray(value)) throw new KvdbQueryError(`${op} expects an array`);
  return value.map((branch) => parseSchemaWhereNode(asObject(op, branch), knownCols));
}

export function parseColumnField(key: string, value: unknown): QueryNode {
  const parts = key.split(".");
  const colName = parts[0]!;
  if (!VALID_PATH_SEGMENT.test(colName)) {
    throw new KvdbQueryError(`Invalid column name in field path "${key}"`);
  }
  const subSegments: PathSegment[] = parts.slice(1).map((part) => {
    if (/^\d+$/.test(part)) {
      return { index: Number(part) };
    }
    if (!VALID_PATH_SEGMENT.test(part)) {
      throw new KvdbQueryError(`Invalid characters in field path segment "${part}"`);
    }
    return { key: part };
  });
  const path: FieldPath = {
    source: colName,
    sourceKind: "column",
    segments: subSegments,
  };
  return parseField(path, value);
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
  knownSchema?: TableSchema | MultiKeySchema | Set<string>,
): SortSpec[] | undefined {
  if (sort === undefined) return undefined;
  const knownCols = extractKnownColumns(knownSchema);
  return sort.map((spec) => {
    const root = spec.path.split(".")[0]!;
    let path: FieldPath;
    if (knownCols.has(root)) {
      const parts = spec.path.split(".");
      if (!VALID_PATH_SEGMENT.test(root)) {
        throw new KvdbQueryError(`Invalid column name in sort path "${spec.path}"`);
      }
      path = {
        source: parts[0]!,
        sourceKind: "column",
        segments: parts.slice(1).map((part) => {
          if (/^\d+$/.test(part)) {
            return { index: Number(part) };
          }
          if (!VALID_PATH_SEGMENT.test(part)) {
            throw new KvdbQueryError(`Invalid characters in sort path segment "${part}"`);
          }
          return { key: part };
        }),
      };
    } else {
      path = parsePath(spec.path);
    }
    return {
      path,
      direction: spec.direction ?? "asc",
    };
  });
}

/** Build FindOptions from the user-facing query document. */
export function parseFindOptions(
  query: {
    limit?: number;
    offset?: number;
    sort?: { path: string; direction?: "asc" | "desc" }[];
  },
  knownSchema?: TableSchema | MultiKeySchema | Set<string>,
): FindOptions {
  if (query.limit !== undefined) {
    if (typeof query.limit !== "number" || !Number.isSafeInteger(query.limit) || query.limit < 0) {
      throw new KvdbQueryError(`Invalid query limit: expected non-negative safe integer, got ${query.limit}`);
    }
  }
  if (query.offset !== undefined) {
    if (typeof query.offset !== "number" || !Number.isSafeInteger(query.offset) || query.offset < 0) {
      throw new KvdbQueryError(`Invalid query offset: expected non-negative safe integer, got ${query.offset}`);
    }
  }
  return {
    limit: query.limit,
    offset: query.offset,
    sort: parseSort(query.sort, knownSchema),
  };
}


