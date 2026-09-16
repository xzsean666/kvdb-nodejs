import { describe, it, expect } from "vitest";
import {
  validateMultiKeySchema,
  validateKeyValues,
  normalizeTableSchema,
  schemasEqual,
  type MultiKeySchema,
  type KeyDefinition,
  type InferKeyType,
  type InferPrimaryKeyType,
  type InferKeysRecord,
} from "../../src/core/table-schema.js";
import { KvdbSchemaError } from "../../src/core/errors.js";

describe("MultiKeySchema: Definition & Validation", () => {
  it("validates a valid multi-key schema with primaryKey and secondary keys", () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        chainId: { type: "string", index: true },
        txHash: { type: "string", index: { unique: true } },
        gasUsed: { type: "number", nullable: true },
        isSuccess: { type: "boolean", default: true },
        meta: { type: "json", nullable: true },
      },
      indexes: [
        { name: "chain_block_idx", keys: ["chainId", "blockNumber"] },
      ],
    };

    expect(() => validateMultiKeySchema(schema)).not.toThrow();
  });

  it("defaults primaryKey to 'key' with type 'string' when omitted", () => {
    const schema: MultiKeySchema = {
      keys: {
        tag: { type: "string" },
      },
    };

    expect(() => validateMultiKeySchema(schema)).not.toThrow();
    const normalized = normalizeTableSchema(schema);
    expect(normalized.primaryKey).toEqual({ name: "key", type: "string" });
    expect(normalized.keys.tag!.type).toBe("string");

  });

  it("rejects reserved words as primaryKey name", () => {
    const reserved = ["value", "expires_at", "created_at", "updated_at"];
    for (const word of reserved) {
      expect(() =>
        validateMultiKeySchema({
          primaryKey: { name: word, type: "string" },
          keys: {},
        }),
      ).toThrow(KvdbSchemaError);
    }
  });

  it("rejects reserved words as secondary key name", () => {
    const reserved = ["value", "expires_at", "created_at", "updated_at"];
    for (const word of reserved) {
      expect(() =>
        validateMultiKeySchema({
          keys: {
            [word]: { type: "string" },
          },
        }),
      ).toThrow(KvdbSchemaError);
    }
  });

  it("rejects primary key name repeated in secondary keys", () => {
    expect(() =>
      validateMultiKeySchema({
        primaryKey: { name: "customKey", type: "string" },
        keys: {
          customKey: { type: "string" },
        },
      }),
    ).toThrow(KvdbSchemaError);
  });

  it("rejects invalid key names containing special characters or colons", () => {
    const invalidNames = ["foo:bar", "foo-bar", "foo.bar", "123num", "foo bar"];
    for (const name of invalidNames) {
      expect(() =>
        validateMultiKeySchema({
          keys: {
            [name]: { type: "string" },
          },
        }),
      ).toThrow(KvdbSchemaError);
    }
  });

  it("rejects unsupported key types", () => {
    expect(() =>
      validateMultiKeySchema({
        // @ts-expect-error testing invalid type at runtime
        keys: { invalid: { type: "blob" } },
      }),
    ).toThrow(KvdbSchemaError);
  });

  it("rejects default values that do not match key type", () => {
    expect(() =>
      validateMultiKeySchema({
        keys: { count: { type: "integer", default: "not-a-number" } },
      }),
    ).toThrow(KvdbSchemaError);

    expect(() =>
      validateMultiKeySchema({
        keys: { enabled: { type: "boolean", default: 123 } },
      }),
    ).toThrow(KvdbSchemaError);
  });

  it("allows null default for nullable keys", () => {
    expect(() =>
      validateMultiKeySchema({
        keys: { optionalData: { type: "string", nullable: true, default: null } },
      }),
    ).not.toThrow();
  });

  it("validates compound index referencing unknown keys", () => {
    expect(() =>
      validateMultiKeySchema({
        keys: { status: { type: "string" } },
        indexes: [{ keys: ["status", "unknownKey"] }],
      }),
    ).toThrow(KvdbSchemaError);

    expect(() =>
      validateMultiKeySchema({
        keys: { status: { type: "string" } },
        indexes: [{ keys: [] }],
      }),
    ).toThrow(KvdbSchemaError);
  });

  it("compares schemas correctly with schemasEqual", () => {
    const schemaA: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: { status: { type: "string", index: true } },
    };
    const schemaB: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: { status: { type: "string", index: true } },
    };
    const schemaC: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: { status: { type: "string", index: false } },
    };

    expect(schemasEqual(schemaA, schemaB)).toBe(true);
    expect(schemasEqual(schemaA, schemaC)).toBe(false);
  });
});

describe("validateKeyValues", () => {
  const schema: MultiKeySchema = {
    keys: {
      str: { type: "string" },
      int: { type: "integer" },
      flt: { type: "number" },
      flag: { type: "boolean" },
      doc: { type: "json" },
      opt: { type: "string", nullable: true },
      def: { type: "integer", default: 42 },
      req: { type: "string", nullable: false },
    },
  };


  it("accepts valid values for all 5 key types", () => {
    const input = {
      str: "hello",
      int: 123,
      flt: 3.1415,
      flag: true,
      doc: { foo: "bar" },
      opt: null,
      req: "required_str",
    };
    expect(validateKeyValues(schema, input)).toEqual(input);
  });

  it("rejects non-integer numbers for integer type", () => {
    expect(() =>
      validateKeyValues(schema, { str: "ok", int: 12.34, flt: 1, flag: false, doc: {}, req: "ok" }),
    ).toThrow(KvdbSchemaError);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      validateKeyValues(schema, { unknownField: "bad", req: "ok" }),
    ).toThrow(KvdbSchemaError);
  });

  it("rejects missing non-nullable keys without default", () => {
    expect(() =>
      validateKeyValues(schema, { str: "ok" }),
    ).toThrow(KvdbSchemaError);
  });

  it("allows omitting keys with default values or nullable keys", () => {
    const result = validateKeyValues(schema, {
      str: "hello",
      int: 1,
      flt: 1.0,
      flag: false,
      doc: "anything",
      req: "is-present",
    });
    expect(result.str).toBe("hello");
    expect(result.req).toBe("is-present");
  });

  it("rejects null for non-nullable keys", () => {
    expect(() =>
      validateKeyValues(schema, {
        str: null,
        int: 1,
        flt: 1.0,
        flag: true,
        doc: {},
        req: "ok",
      }),
    ).toThrow(KvdbSchemaError);
  });

});

describe("TypeScript Type Inference", () => {
  it("infers key types properly at compile-time", () => {
    type TestKeys = {
      name: KeyDefinition<"string">;
      age: KeyDefinition<"integer">;
      score: KeyDefinition<"number">;
      active: KeyDefinition<"boolean">;
      profile: KeyDefinition<"json">;
    };

    type Inferred = InferKeysRecord<TestKeys>;
    const sample: Inferred = {
      name: "alice",
      age: 30,
      score: 99.5,
      active: true,
      profile: { bio: "engineer" },
    };

    expect(sample.name).toBe("alice");
    expect(sample.age).toBe(30);

    type PKInt = InferPrimaryKeyType<"integer">;
    type PKStr = InferPrimaryKeyType<"string">;
    type PKDef = InferPrimaryKeyType<undefined>;

    const pkInt: PKInt = 100;
    const pkStr: PKStr = "id-1";
    const pkDef: PKDef = "default-id";

    expect(pkInt).toBe(100);
    expect(pkStr).toBe("id-1");
    expect(pkDef).toBe("default-id");
  });
});
