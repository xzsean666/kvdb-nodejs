import { describe, it, expect } from "vitest";
import {
  serialize,
  deserialize,
  stableStringify,
} from "../../src/core/serializer.js";
import { KvdbSerializationError } from "../../src/core/errors.js";

describe("serialize", () => {
  it("produces canonical output with sorted keys", () => {
    expect(serialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(serialize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("is order-independent for nested objects", () => {
    const left = serialize({ x: { c: 3, a: 1 }, y: [1, 2] });
    const right = serialize({ y: [1, 2], x: { a: 1, c: 3 } });
    expect(left).toBe(right);
  });

  it("round-trips primitives and structures", () => {
    for (const value of [null, true, false, 0, 42, -1.5, "hi", [], {}]) {
      expect(deserialize(serialize(value))).toEqual(value);
    }
    const complex = { a: [1, { b: "x" }], c: null };
    expect(deserialize(serialize(complex))).toEqual(complex);
  });

  it("drops undefined object properties", () => {
    expect(serialize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("renders undefined array slots as null", () => {
    expect(serialize([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("honors toJSON (Date)", () => {
    const date = new Date("2026-05-29T00:00:00.000Z");
    expect(serialize({ at: date })).toBe('{"at":"2026-05-29T00:00:00.000Z"}');
  });

  it("throws on circular references", () => {
    const node: Record<string, unknown> = {};
    node.self = node;
    expect(() => serialize(node)).toThrow(KvdbSerializationError);
  });

  it("throws on non-finite numbers", () => {
    expect(() => serialize(NaN)).toThrow(KvdbSerializationError);
    expect(() => serialize(Infinity)).toThrow(KvdbSerializationError);
  });

  it("throws on bigint and functions", () => {
    expect(() => serialize(1n)).toThrow(KvdbSerializationError);
    expect(() => serialize(() => 0)).toThrow(KvdbSerializationError);
  });
});

describe("deserialize", () => {
  it("throws a serialization error on invalid JSON", () => {
    expect(() => deserialize("{not json")).toThrow(KvdbSerializationError);
  });
});

describe("stableStringify", () => {
  it("encodes top-level undefined", () => {
    expect(stableStringify(undefined)).toBe("undefined");
  });

  it("is deterministic across key order (stable cache keys)", () => {
    expect(stableStringify({ id: 1, q: "a" })).toBe(stableStringify({ q: "a", id: 1 }));
  });
});
