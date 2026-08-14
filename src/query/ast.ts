// Query IR/AST — backend-agnostic (docs/ARCHITECTURE.md KD-2).
//
// A Mongo-style query document is parsed into this AST (query/parser.ts), then
// each backend lowers the AST to its native query via a BackendVisitor
// (query/compiler.ts). This is the single place that defines query semantics;
// backends only translate.

import type { JsonValue } from "../types/json.js";

/** Comparison operators supported in v1 (see docs/SPEC.md §6.2). */
export type CompareOp =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin";

/**
 * A path into a JSON value. Segments are object keys or array indices.
 * Example: "profile.age" -> [{ key: "profile" }, { key: "age" }].
 * Array indices are represented abstractly so each backend can render them
 * (SQLite `$[0]`, Postgres `{0}`) — including negative indices.
 */
export type PathSegment = { key: string } | { index: number };

export interface FieldPath {
  segments: PathSegment[];
  /** Original dotted source, kept for error messages and cache keys. */
  source: string;
  sourceKind?: "value" | "column";
}

export type QueryNode =
  | { kind: "and"; children: QueryNode[] }
  | { kind: "or"; children: QueryNode[] }
  | { kind: "nor"; children: QueryNode[] }
  | { kind: "not"; child: QueryNode }
  | { kind: "cmp"; op: CompareOp; path: FieldPath; value: JsonValue }
  | { kind: "exists"; path: FieldPath; value: boolean }
  | { kind: "elemMatch"; path: FieldPath; child: QueryNode }
  /** Matches everything; produced by an empty `where`. */
  | { kind: "true" };

/** Sort direction for a single field. */
export interface SortSpec {
  path: FieldPath;
  direction: "asc" | "desc";
}

/** Options accompanying a `find` (already parsed from the user query document). */
export interface FindOptions {
  limit?: number;
  offset?: number;
  sort?: SortSpec[];
}
