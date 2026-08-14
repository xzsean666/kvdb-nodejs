// SQLite SQL dialect for the query compiler (docs/ARCHITECTURE.md §4.2).
//
// SQLite's json_extract returns the JSON value already converted to a SQL type
// (numbers as INTEGER/REAL, strings as TEXT, true/false as 1/0, JSON null as
// SQL NULL), so numeric and string comparisons work without explicit casts.
// json_type returns NULL only when the path is absent, which gives us a clean
// presence test that distinguishes "missing" from "present but null".

import type { SqlDialect } from "../../query/compiler.js";
import type { FieldPath } from "../../query/ast.js";
import type { JsonValue } from "../../types/json.js";

export class SqliteDialect implements SqlDialect {
  constructor(private readonly column: string = "value") {}

  scalarAt(path: FieldPath): string {
    // SQLite's json_extract already returns a typed scalar, so the comparison
    // value hint is unnecessary here.
    if (path.sourceKind === "column") return quoteIdentifier(path.source);
    return `json_extract(${this.column}, '${jsonPath(path)}')`;
  }

  pathExists(path: FieldPath): string {
    if (path.sourceKind === "column") return `${quoteIdentifier(path.source)} IS NOT NULL`;
    return `json_type(${this.column}, '${jsonPath(path)}') IS NOT NULL`;
  }

  placeholder(): string {
    return "?";
  }

  coerceParam(value: JsonValue): unknown {
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid identifier: ${value}`);
  return `\"${value}\"`;
}

/** Render a FieldPath as a SQLite JSON path string, e.g. `$.profile.age` / `$.tags[0]`. */
function jsonPath(path: FieldPath): string {
  let result = "$";
  for (const segment of path.segments) {
    result += "index" in segment ? `[${segment.index}]` : `.${segment.key}`;
  }
  return result;
}
