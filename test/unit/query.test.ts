import { describe, it, expect } from "vitest";
import { parseWhere, parsePath } from "../../src/query/parser.js";
import { compileWhere } from "../../src/query/compiler.js";
import { SqliteDialect } from "../../src/drivers/sqlite/dialect.js";
import { KvdbQueryError } from "../../src/core/errors.js";

const dialect = new SqliteDialect();
const compile = (where: Record<string, unknown>) => compileWhere(parseWhere(where), dialect);

describe("parsePath", () => {
  it("splits dotted paths and detects array indices", () => {
    expect(parsePath("profile.age").segments).toEqual([{ key: "profile" }, { key: "age" }]);
    expect(parsePath("tags.0").segments).toEqual([{ key: "tags" }, { index: 0 }]);
  });
});

describe("parseWhere -> AST", () => {
  it("treats a bare value as $eq", () => {
    expect(parseWhere({ status: "active" })).toEqual({
      kind: "cmp",
      op: "$eq",
      path: parsePath("status"),
      value: "active",
    });
  });

  it("returns a true node for empty where", () => {
    expect(parseWhere({})).toEqual({ kind: "true" });
  });

  it("rejects unknown operators", () => {
    expect(() => parseWhere({ age: { $weird: 1 } })).toThrow(KvdbQueryError);
  });
});

describe("compileWhere (SQLite)", () => {
  it("compiles equality", () => {
    const { sql, params } = compile({ status: "active" });
    expect(sql).toBe("json_extract(value, '$.status') = ?");
    expect(params).toEqual(["active"]);
  });

  it("compiles nested comparison", () => {
    const { sql, params } = compile({ "profile.age": { $gt: 18 } });
    expect(sql).toBe("json_extract(value, '$.profile.age') > ?");
    expect(params).toEqual([18]);
  });

  it("combines multiple field conditions with AND", () => {
    const { sql } = compile({ "profile.age": { $gte: 18, $lt: 65 } });
    expect(sql).toContain("AND");
    expect(sql).toContain(">=");
    expect(sql).toContain("<");
  });

  it("compiles $or", () => {
    const { sql, params } = compile({ $or: [{ vip: true }, { credits: { $gte: 100 } }] });
    expect(sql).toContain(" OR ");
    expect(params).toEqual([1, 100]); // boolean true coerced to 1
  });

  it("compiles $in / empty $in", () => {
    expect(compile({ role: { $in: ["a", "b"] } }).sql).toBe(
      "json_extract(value, '$.role') IN (?, ?)",
    );
    expect(compile({ role: { $in: [] } }).sql).toBe("1=0");
  });

  it("compiles $ne to also match missing fields", () => {
    const { sql } = compile({ status: { $ne: "gone" } });
    expect(sql).toContain("IS NULL OR");
    expect(sql).toContain("<>");
  });

  it("compiles $exists with presence test", () => {
    expect(compile({ email: { $exists: true } }).sql).toBe(
      "json_type(value, '$.email') IS NOT NULL",
    );
    expect(compile({ email: { $exists: false } }).sql).toBe(
      "NOT (json_type(value, '$.email') IS NOT NULL)",
    );
  });

  it("compiles $eq null as IS NULL", () => {
    expect(compile({ deleted: null }).sql).toBe("json_extract(value, '$.deleted') IS NULL");
  });
});
