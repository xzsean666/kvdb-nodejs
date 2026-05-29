// Collect the JSON field paths referenced by a query AST.
//
// Used by the optional auto-index feature (core/auto-index.ts) to learn which
// paths are queried often enough to deserve an index. Kept separate from the
// compiler so it has one clear job: AST -> list of dotted path strings.

import type { QueryNode, SortSpec } from "./ast.js";

export function collectFieldPaths(node: QueryNode, sort?: SortSpec[]): string[] {
  const paths: string[] = [];
  walk(node, paths);
  for (const spec of sort ?? []) paths.push(spec.path.source);
  return paths;
}

function walk(node: QueryNode, out: string[]): void {
  switch (node.kind) {
    case "and":
    case "or":
    case "nor":
      for (const child of node.children) walk(child, out);
      return;
    case "not":
      walk(node.child, out);
      return;
    case "elemMatch":
      out.push(node.path.source);
      walk(node.child, out);
      return;
    case "cmp":
    case "exists":
      out.push(node.path.source);
      return;
    case "true":
      return;
  }
}
