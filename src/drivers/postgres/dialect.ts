// PostgreSQL (jsonb) SQL dialect for the query compiler (docs/ARCHITECTURE.md §4.2).
//
// The value is stored as TEXT (canonical JSON, for exact round-trips) and cast
// to jsonb for querying. jsonb's `#>>` path operator always returns TEXT, so —
// unlike SQLite — we must cast the extracted scalar to match the comparison
// value's type (numeric/boolean), or numeric comparisons would sort lexically.
// `#>>` over a *missing* path yields SQL NULL, giving a clean presence test via
// jsonb_extract_path (NULL = absent), aligned with Mongo $exists semantics.
//
// The numeric/boolean cast is guarded by `jsonb_typeof(...) = '<type>'` inside a
// CASE: a plain `(text)::numeric` THROWS on a row whose value at the path is a
// string (e.g. one document storing `{age:"old"}`), which would crash an entire
// query. The CASE yields NULL for the wrong type instead — Mongo-style type
// bracketing — and never raises. ensureIndex builds an index on this exact
// expression, so range/eq queries stay index-backed.

import type { SqlDialect } from "../../query/compiler.js";
import type { FieldPath } from "../../query/ast.js";
import type { JsonValue } from "../../types/json.js";

export class PostgresDialect implements SqlDialect {
  constructor(private readonly column: string = "value") {}

  scalarAt(path: FieldPath, valueHint?: JsonValue): string {
    const json = `'{${pathArray(path)}}'`;
    const text = `((${this.column})::jsonb #>> ${json})`;
    switch (typeof valueHint) {
      case "number":
        return this.typedCast(json, text, "number", "numeric");
      case "boolean":
        return this.typedCast(json, text, "boolean", "boolean");
      default:
        return text;
    }
  }

  /**
   * `CASE WHEN jsonb_typeof(path) = '<jsonType>' THEN (text)::<sqlType> END` —
   * a NULL-on-mismatch cast that never throws on heterogeneous JSON.
   */
  private typedCast(json: string, text: string, jsonType: string, sqlType: string): string {
    const typeof_ = `jsonb_typeof((${this.column})::jsonb #> ${json})`;
    return `(CASE WHEN ${typeof_} = '${jsonType}' THEN (${text})::${sqlType} END)`;
  }

  pathExists(path: FieldPath): string {
    return `jsonb_extract_path((${this.column})::jsonb, ${pathLiterals(path)}) IS NOT NULL`;
  }

  placeholder(position: number): string {
    return `$${position + 1}`;
  }

  coerceParam(value: JsonValue): unknown {
    // node-postgres maps JS numbers/booleans/strings to the right types.
    return value;
  }
}

/** `profile.age` -> `profile,age` for the `#>> '{...}'` text path operator. */
function pathArray(path: FieldPath): string {
  return path.segments
    .map((segment) => ("index" in segment ? String(segment.index) : segment.key))
    .join(",");
}

/** `profile.age` -> `'profile','age'` for jsonb_extract_path(...) arguments. */
function pathLiterals(path: FieldPath): string {
  return path.segments
    .map((segment) =>
      "index" in segment ? `'${segment.index}'` : `'${segment.key.replace(/'/g, "''")}'`,
    )
    .join(", ");
}
