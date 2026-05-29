// Query compiler — lowers a QueryNode AST into SQL (docs/ARCHITECTURE.md KD-2).
//
// The logical structure (and/or/nor/not) is backend-agnostic and handled here.
// Only the parts that genuinely differ between SQL engines — how to extract a
// scalar at a JSON path, how to test presence, and the placeholder style — are
// delegated to a `SqlDialect`. SQLite and Postgres each provide one; the walker
// is shared. This is the "per-backend visitor" from the architecture.

import type { CompareOp, FieldPath, QueryNode, SortSpec } from "./ast.js";
import type { JsonValue } from "../types/json.js";
import { KvdbQueryError } from "../core/errors.js";

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * The engine-specific knobs. A dialect renders JSON access and placeholders;
 * everything else (boolean structure, IN lists, presence) is composed here.
 */
export interface SqlDialect {
  /** SQL expression returning the typed scalar stored at `path`. */
  scalarAt(path: FieldPath): string;
  /** SQL boolean expression that is true when `path` exists in the document. */
  pathExists(path: FieldPath): string;
  /** Render the placeholder for the param at zero-based `position`. */
  placeholder(position: number): string;
  /** Coerce a JS value into the engine's bound-parameter form. */
  coerceParam(value: JsonValue): unknown;
}

/** Compile a WHERE AST into an SQL fragment with positional params. */
export function compileWhere(node: QueryNode, dialect: SqlDialect): SqlFragment {
  const params: unknown[] = [];
  const sql = walk(node, dialect, params);
  return { sql, params };
}

/** Compile sort specs into an ORDER BY clause (without the keyword). */
export function compileOrderBy(sort: SortSpec[], dialect: SqlDialect): string {
  return sort
    .map((spec) => `${dialect.scalarAt(spec.path)} ${spec.direction === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
}

function walk(node: QueryNode, dialect: SqlDialect, params: unknown[]): string {
  switch (node.kind) {
    case "true":
      return "1=1";
    case "and":
      return combine(node.children, "AND", dialect, params);
    case "or":
      return combine(node.children, "OR", dialect, params);
    case "nor":
      return `NOT (${combine(node.children, "OR", dialect, params)})`;
    case "not":
      return `NOT (${walk(node.child, dialect, params)})`;
    case "exists":
      return node.value ? dialect.pathExists(node.path) : `NOT (${dialect.pathExists(node.path)})`;
    case "cmp":
      return compileCompare(node.op, node.path, node.value, dialect, params);
    case "elemMatch":
      // v1: not yet supported by the SQL dialects; surfaced explicitly.
      throw new KvdbQueryError("$elemMatch is not supported by the SQL backends in v1");
    default: {
      const exhaustive: never = node;
      throw new KvdbQueryError(`Unhandled query node: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function combine(
  children: QueryNode[],
  operator: "AND" | "OR",
  dialect: SqlDialect,
  params: unknown[],
): string {
  if (children.length === 0) return operator === "AND" ? "1=1" : "1=0";
  return children.map((child) => `(${walk(child, dialect, params)})`).join(` ${operator} `);
}

function compileCompare(
  op: CompareOp,
  path: FieldPath,
  value: JsonValue,
  dialect: SqlDialect,
  params: unknown[],
): string {
  const left = dialect.scalarAt(path);

  if (op === "$in" || op === "$nin") {
    if (!Array.isArray(value)) {
      throw new KvdbQueryError(`${op} expects an array at "${path.source}"`);
    }
    if (value.length === 0) {
      // $in [] matches nothing; $nin [] matches everything.
      return op === "$in" ? "1=0" : "1=1";
    }
    const placeholders = value.map((item) => bind(dialect, params, item)).join(", ");
    return op === "$in" ? `${left} IN (${placeholders})` : `${left} NOT IN (${placeholders})`;
  }

  if (op === "$ne") {
    // Mongo $ne also matches when the field is absent/null.
    return `(${dialect.scalarAt(path)} IS NULL OR ${left} <> ${bind(dialect, params, value)})`;
  }

  const sqlOperator = { $eq: "=", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" }[op];
  if (value === null && op === "$eq") {
    return `${left} IS NULL`;
  }
  return `${left} ${sqlOperator} ${bind(dialect, params, value)}`;
}

function bind(dialect: SqlDialect, params: unknown[], value: JsonValue): string {
  const placeholder = dialect.placeholder(params.length);
  params.push(dialect.coerceParam(value));
  return placeholder;
}
