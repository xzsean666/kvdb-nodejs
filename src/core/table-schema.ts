import type { JsonValue } from "../types/json.js";
import { KvdbSchemaError } from "./errors.js";

export type PhysicalColumnType = "string" | "integer" | "number" | "boolean" | "json";
export interface ColumnIndexOptions { name?: string; unique?: boolean }
export interface ColumnDefinition {
  type: PhysicalColumnType;
  nullable?: boolean;
  default?: JsonValue;
  index?: boolean | ColumnIndexOptions;
}
export interface TableIndexDefinition { name?: string; columns: string[]; unique?: boolean }
export interface TableSchema<Columns extends Record<string, unknown> = Record<string, unknown>> {
  columns: { [Name in keyof Columns]-?: ColumnDefinition } & Record<string, ColumnDefinition>;
  indexes?: TableIndexDefinition[];
  version?: number;
}
export interface PhysicalRecord<Columns extends Record<string, unknown>, Value> {
  key: string;
  columns: Partial<Columns>;
  value: Value;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["key", "value", "expires_at", "created_at", "updated_at"]);

export function validateTableSchema(schema: TableSchema): void {
  for (const [name, definition] of Object.entries(schema.columns)) {
    if (!IDENTIFIER.test(name) || RESERVED.has(name)) throw new KvdbSchemaError(`Invalid or reserved column name: ${name}`);
    if (!["string", "integer", "number", "boolean", "json"].includes(definition.type)) {
      throw new KvdbSchemaError(`Invalid column type for ${name}`);
    }
    if (definition.default !== undefined && definition.default === undefined) {
      throw new KvdbSchemaError(`Invalid default for ${name}`);
    }
  }
  for (const index of schema.indexes ?? []) {
    if (!index.columns.length) throw new KvdbSchemaError("Index must contain at least one column");
    for (const column of index.columns) {
      if (!(column in schema.columns)) throw new KvdbSchemaError(`Index references unknown column: ${column}`);
    }
    if (index.name !== undefined && !IDENTIFIER.test(index.name)) throw new KvdbSchemaError(`Invalid index name: ${index.name}`);
  }
}

export function schemasEqual(left: TableSchema, right: TableSchema): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateColumnValues(schema: TableSchema, columns: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = columns ?? {};
  for (const key of Object.keys(input)) if (!(key in schema.columns)) throw new KvdbSchemaError(`Unknown column: ${key}`);
  for (const [name, definition] of Object.entries(schema.columns)) {
    const value = input[name];
    if (value === undefined && definition.nullable === false && definition.default === undefined) {
      throw new KvdbSchemaError(`Required column is missing: ${name}`);
    }
    if (value !== undefined && !matchesType(value, definition.type)) throw new KvdbSchemaError(`Invalid value for column ${name}`);
  }
  return input;
}

function matchesType(value: unknown, type: PhysicalColumnType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return value !== undefined;
}
