// MySQL SQL dialect for the query compiler (docs/ARCHITECTURE.md §4.2).
//
// MySQL 5.7+ / 8.0+ JSON support:
// - `JSON_UNQUOTE(JSON_EXTRACT(col, '$.path'))` (or `col->>'$.path'`) returns unquoted text.
// - Numeric comparisons cast unquoted text via `(JSON_EXTRACT(...) + 0)` or `CAST(... AS DOUBLE)`
//   to ensure numeric sorting and range semantics rather than lexical.
// - Presence is tested via `JSON_CONTAINS_PATH(col, 'one', '$.path')`.

import type { SqlDialect } from "../../query/compiler.js";
import type { FieldPath } from "../../query/ast.js";
import type { JsonValue } from "../../types/json.js";

export class MysqlDialect implements SqlDialect {
  private readonly column: string;

  constructor(column: string = "value") {
    this.column = column === "value" ? "`value`" : quoteIdentifier(column);
  }

  scalarAt(path: FieldPath, valueHint?: JsonValue): string {
    if (path.sourceKind === "column") {
      const col = quoteIdentifier(path.source);
      if (path.segments.length === 0) return col;
      const jPath = jsonPath(path);
      return this.renderJsonScalar(col, jPath, valueHint);
    }
    const jPath = jsonPath(path);
    return this.renderJsonScalar(this.column, jPath, valueHint);
  }

  private renderJsonScalar(sourceCol: string, jPath: string, valueHint?: JsonValue): string {
    if (typeof valueHint === "number") {
      return `CAST(JSON_UNQUOTE(JSON_EXTRACT(${sourceCol}, '${jPath}')) AS DOUBLE)`;
    }
    if (typeof valueHint === "boolean") {
      return `(JSON_EXTRACT(${sourceCol}, '${jPath}') = true)`;
    }
    return `JSON_UNQUOTE(JSON_EXTRACT(${sourceCol}, '${jPath}'))`;
  }

  pathExists(path: FieldPath): string {
    if (path.sourceKind === "column") {
      const col = quoteIdentifier(path.source);
      if (path.segments.length === 0) return `${col} IS NOT NULL`;
      return `JSON_CONTAINS_PATH(${col}, 'one', '${jsonPath(path)}') = 1`;
    }
    return `JSON_CONTAINS_PATH(${this.column}, 'one', '${jsonPath(path)}') = 1`;
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
  return `\`${value}\``;
}

/** Render a FieldPath as a MySQL JSON path string, e.g. `$.profile.age` / `$.tags[0]`. */
function jsonPath(path: FieldPath): string {
  let result = "$";
  for (const segment of path.segments) {
    result += "index" in segment ? `[${segment.index}]` : `.${segment.key}`;
  }
  return result;
}
