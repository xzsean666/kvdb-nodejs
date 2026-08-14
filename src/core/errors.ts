// Named, discriminable error types (docs/SPEC.md §11).
//
// Every error carries a stable `code` so callers can branch without string
// matching. Errors are explicit — thrown at the boundary where the problem is
// detected, never swallowed.

export type KvdbErrorCode =
  | "CONNECTION"
  | "QUERY"
  | "SERIALIZATION"
  | "UNSUPPORTED"
  | "CONFIG";

export class KvdbError extends Error {
  readonly code: KvdbErrorCode;

  constructor(code: KvdbErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KvdbError";
    this.code = code;
  }
}

export class KvdbConnectionError extends KvdbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CONNECTION", message, options);
    this.name = "KvdbConnectionError";
  }
}

export class KvdbQueryError extends KvdbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("QUERY", message, options);
    this.name = "KvdbQueryError";
  }
}

export class KvdbSerializationError extends KvdbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("SERIALIZATION", message, options);
    this.name = "KvdbSerializationError";
  }
}

export class KvdbUnsupportedError extends KvdbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("UNSUPPORTED", message, options);
    this.name = "KvdbUnsupportedError";
  }
}

export class KvdbConfigError extends KvdbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CONFIG", message, options);
    this.name = "KvdbConfigError";
  }
}

export class KvdbSchemaError extends KvdbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CONFIG", message, options);
    this.name = "KvdbSchemaError";
  }
}

export class KvdbMigrationError extends KvdbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CONFIG", message, options);
    this.name = "KvdbMigrationError";
  }
}
