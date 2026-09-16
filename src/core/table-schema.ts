import type { JsonValue } from "../types/json.js";
import { KvdbSchemaError } from "./errors.js";

/** Supported data types for secondary and primary keys. */
export type KeyType = "string" | "integer" | "number" | "boolean" | "json";
export type PrimaryKeyType = "string" | "integer";

/** Backward-compatible alias for KeyType. */
export type PhysicalColumnType = KeyType;

export interface KeyIndexOptions {
  name?: string;
  unique?: boolean;
}

/** Backward-compatible alias for KeyIndexOptions. */
export type ColumnIndexOptions = KeyIndexOptions;

export interface KeyDefinition<T extends KeyType = KeyType> {
  type: T;
  nullable?: boolean;
  default?: unknown;
  index?: boolean | KeyIndexOptions;
}

/** Backward-compatible alias for KeyDefinition. */
export type ColumnDefinition = KeyDefinition;

export interface PrimaryKeyDefinition<T extends PrimaryKeyType = PrimaryKeyType> {
  name: string;
  type?: T;
}

export interface TableIndexDefinition {
  name?: string;
  columns: string[];
  keys?: string[];
  unique?: boolean;
}

export interface MultiKeyIndexDefinition {
  name?: string;
  keys?: string[];
  columns?: string[];
  unique?: boolean;
}

export interface MultiKeySchema<
  Keys extends Record<string, unknown> = Record<string, unknown>,
  PKType extends PrimaryKeyType = PrimaryKeyType
> {
  primaryKey?: PrimaryKeyDefinition<PKType>;
  keys: { [Name in keyof Keys]-?: KeyDefinition } & Record<string, KeyDefinition>;
  indexes?: MultiKeyIndexDefinition[];
  version?: number;
  /** Backward-compatible alias for keys */
  columns?: { [Name in keyof Keys]-?: KeyDefinition } & Record<string, KeyDefinition>;
}

/** Unified TableSchema compatible with both MultiKeySchema and legacy column schemas. */
export interface TableSchema<Columns extends Record<string, unknown> = Record<string, unknown>> {
  primaryKey?: PrimaryKeyDefinition;
  columns: { [Name in keyof Columns]-?: KeyDefinition } & Record<string, KeyDefinition>;
  keys?: { [Name in keyof Columns]-?: KeyDefinition } & Record<string, KeyDefinition>;
  indexes?: TableIndexDefinition[];
  version?: number;
}

export interface PhysicalRecord<
  Columns extends Record<string, unknown> = Record<string, unknown>,
  Value = unknown,
  PK = string | number
> {
  key: PK;
  columns: Partial<Columns>;
  keys?: Partial<Columns>;
  value: Value;
}


// Type inference utilities
export type InferKeyType<T extends KeyType> =
  T extends "string" ? string :
  T extends "integer" ? number :
  T extends "number" ? number :
  T extends "boolean" ? boolean :
  T extends "json" ? JsonValue :
  never;

export type InferPrimaryKeyType<T extends PrimaryKeyType | undefined> =
  T extends "integer" ? number : string;

export type InferKeysRecord<T extends Record<string, KeyDefinition>> = {
  [K in keyof T]: T[K]["nullable"] extends true
    ? InferKeyType<T[K]["type"]> | null | undefined
    : InferKeyType<T[K]["type"]>;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["value", "expires_at", "created_at", "updated_at"]);

export interface NormalizedSchema {
  primaryKey: { name: string; type: PrimaryKeyType };
  keys: Record<string, KeyDefinition>;
  columns: Record<string, KeyDefinition>;
  indexes: Array<{ name?: string; keys: string[]; columns: string[]; unique?: boolean }>;
  version: number;
}

/**
 * Normalize any TableSchema or MultiKeySchema into a canonical representation
 * where primaryKey, keys, and columns are guaranteed to be populated.
 */
export function normalizeTableSchema(schema: TableSchema | MultiKeySchema): NormalizedSchema {
  const pkName = schema.primaryKey?.name ?? "key";
  const pkType: PrimaryKeyType = schema.primaryKey?.type ?? "string";
  const rawKeys = schema.keys ?? schema.columns ?? {};

  const indexes = (schema.indexes ?? []).map((idx) => {
    const cols = idx.keys ?? idx.columns ?? [];
    return {
      name: idx.name,
      keys: cols,
      columns: cols,
      unique: idx.unique,
    };
  });

  return {
    primaryKey: { name: pkName, type: pkType },
    keys: rawKeys,
    columns: rawKeys,
    indexes,
    version: schema.version ?? 1,
  };
}

export function validateMultiKeySchema(schema: TableSchema | MultiKeySchema): void {
  const pkName = schema.primaryKey?.name ?? "key";
  const pkType = schema.primaryKey?.type ?? "string";

  if (!IDENTIFIER.test(pkName)) {
    throw new KvdbSchemaError(`Invalid primary key name: ${pkName}`);
  }
  if (RESERVED.has(pkName)) {
    throw new KvdbSchemaError(`Primary key cannot use reserved word: ${pkName}`);
  }
  if (pkType !== "string" && pkType !== "integer") {
    throw new KvdbSchemaError(`Invalid primary key type: ${pkType}. Allowed: "string" | "integer"`);
  }

  const keys = schema.keys ?? schema.columns ?? {};

  if (pkName in keys) {
    throw new KvdbSchemaError(`Primary key "${pkName}" cannot also be declared in secondary keys`);
  }

  for (const [name, definition] of Object.entries(keys)) {
    if (!IDENTIFIER.test(name)) {
      throw new KvdbSchemaError(`Invalid key name: ${name}`);
    }
    if (RESERVED.has(name)) {
      throw new KvdbSchemaError(`Key name cannot use reserved word: ${name}`);
    }
    if (!["string", "integer", "number", "boolean", "json"].includes(definition.type)) {
      throw new KvdbSchemaError(`Invalid key type for ${name}: ${definition.type}`);
    }
    if (definition.default !== undefined) {
      if (!matchesType(definition.default, definition.type)) {
        if (!(definition.nullable && definition.default === null)) {
          throw new KvdbSchemaError(`Default value for "${name}" does not match type "${definition.type}"`);
        }
      }
    }
    if (typeof definition.index === "object" && definition.index !== null) {
      if (definition.index.name !== undefined && !IDENTIFIER.test(definition.index.name)) {
        throw new KvdbSchemaError(`Invalid index name for "${name}": ${definition.index.name}`);
      }
    }
  }

  for (const index of schema.indexes ?? []) {
    const cols = index.keys ?? index.columns ?? [];
    if (!cols.length) {
      throw new KvdbSchemaError("Index must contain at least one key");
    }
    for (const key of cols) {
      if (key !== pkName && !(key in keys)) {
        throw new KvdbSchemaError(`Index references unknown key: ${key}`);
      }
    }
    if (index.name !== undefined && !IDENTIFIER.test(index.name)) {
      throw new KvdbSchemaError(`Invalid index name: ${index.name}`);
    }
  }
}

/** Backward-compatible alias for validateMultiKeySchema. */
export const validateTableSchema = validateMultiKeySchema;

export function schemasEqual(left: TableSchema | MultiKeySchema, right: TableSchema | MultiKeySchema): boolean {
  const normLeft = normalizeTableSchema(left);
  const normRight = normalizeTableSchema(right);
  return JSON.stringify(normLeft) === JSON.stringify(normRight);
}

export function validateKeyValues(
  schema: TableSchema | MultiKeySchema,
  keys: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const input = keys ?? {};
  const schemaKeys = schema.keys ?? schema.columns ?? {};

  for (const key of Object.keys(input)) {
    if (!(key in schemaKeys)) {
      throw new KvdbSchemaError(`Unknown key: ${key}`);
    }
  }

  for (const [name, definition] of Object.entries(schemaKeys)) {
    const value = input[name];
    if (value === undefined) {
      if (definition.nullable === false && definition.default === undefined) {
        throw new KvdbSchemaError(`Required key is missing: ${name}`);
      }
      continue;
    }
    if (value === null) {
      if (definition.nullable !== true) {
        throw new KvdbSchemaError(`Key "${name}" is not nullable`);
      }
      continue;
    }
    if (!matchesType(value, definition.type)) {
      throw new KvdbSchemaError(`Invalid value for key "${name}" (expected ${definition.type}, got ${typeof value})`);
    }
  }


  return input;
}

/** Backward-compatible alias for validateKeyValues. */
export const validateColumnValues = validateKeyValues;

/**
 * Evolves an existing schema by adding a new secondary key.
 * - Throws KvdbSchemaError if the key name is invalid, reserved, or conflicts with the primary key.
 * - Idempotent: if a key with the exact same definition already exists, returns the original schema unchanged.
 * - If a key with the same name exists with a different definition, throws KvdbSchemaError.
 * - Increments version number on successful addition.
 */
export function evolveSchemaAddKey(
  schema: TableSchema | MultiKeySchema,
  name: string,
  definition: KeyDefinition,
): NormalizedSchema {
  const norm = normalizeTableSchema(schema);

  if (!IDENTIFIER.test(name)) {
    throw new KvdbSchemaError(`Invalid key name: ${name}`);
  }
  if (RESERVED.has(name)) {
    throw new KvdbSchemaError(`Key name cannot use reserved word: ${name}`);
  }
  if (name === norm.primaryKey.name) {
    throw new KvdbSchemaError(`Key "${name}" conflicts with primary key name`);
  }
  if (!["string", "integer", "number", "boolean", "json"].includes(definition.type)) {
    throw new KvdbSchemaError(`Invalid key type for ${name}: ${definition.type}`);
  }
  if (definition.default !== undefined) {
    if (!matchesType(definition.default, definition.type)) {
      if (!(definition.nullable && definition.default === null)) {
        throw new KvdbSchemaError(`Default value for "${name}" does not match type "${definition.type}"`);
      }
    }
  }

  const existing = norm.keys[name];
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(definition)) {
      return norm;
    }
    throw new KvdbSchemaError(
      `Cannot add key "${name}": already exists with conflicting definition (${JSON.stringify(existing)} vs ${JSON.stringify(definition)})`,
    );
  }

  const updatedKeys = { ...norm.keys, [name]: definition };
  const updatedIndexes = [...norm.indexes];

  if (definition.index) {
    const idxOptions = typeof definition.index === "object" ? definition.index : {};
    const idxName = idxOptions.name ?? `${name}_idx`;
    updatedIndexes.push({
      name: idxName,
      keys: [name],
      columns: [name],
      unique: idxOptions.unique,
    });
  }

  return {
    primaryKey: norm.primaryKey,
    keys: updatedKeys,
    columns: updatedKeys,
    indexes: updatedIndexes,
    version: norm.version + 1,
  };
}

/**
 * Evolves an existing schema by adding a compound or secondary index.
 * - Idempotent: if an index with identical keys/columns exists, returns the original schema.
 * - Increments version number on successful addition.
 */
export function evolveSchemaAddIndex(
  schema: TableSchema | MultiKeySchema,
  index: TableIndexDefinition | MultiKeyIndexDefinition,
): NormalizedSchema {
  const norm = normalizeTableSchema(schema);
  const cols = index.keys ?? index.columns ?? [];

  if (!cols.length) {
    throw new KvdbSchemaError("Index must contain at least one key");
  }
  for (const key of cols) {
    if (key !== norm.primaryKey.name && !(key in norm.keys)) {
      throw new KvdbSchemaError(`Index references unknown key: ${key}`);
    }
  }
  if (index.name !== undefined && !IDENTIFIER.test(index.name)) {
    throw new KvdbSchemaError(`Invalid index name: ${index.name}`);
  }

  const existing = norm.indexes.find(
    (idx) => idx.keys.join(",") === cols.join(",") && Boolean(idx.unique) === Boolean(index.unique),
  );
  if (existing) {
    return norm;
  }

  const newIndex = {
    name: index.name ?? `${cols.join("_")}_idx`,
    keys: cols,
    columns: cols,
    unique: index.unique,
  };

  return {
    primaryKey: norm.primaryKey,
    keys: norm.keys,
    columns: norm.columns,
    indexes: [...norm.indexes, newIndex],
    version: norm.version + 1,
  };
}

function matchesType(value: unknown, type: KeyType): boolean {

  if (type === "string") return typeof value === "string";
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return value !== undefined;
}

