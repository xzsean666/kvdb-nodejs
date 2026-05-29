// Physical key resolution (docs/ARCHITECTURE.md §3, KD-1).
//
// All namespace/prefix logic lives here, in ONE layer. Drivers receive only
// physical keys and never rewrite them — this avoids the double-prefix class of
// bugs that comes from splitting key resolution across core and adapters.
//
// Physical layout:  <tablePrefix><namespace>:<userKey>
// Namespace scan:   <tablePrefix><namespace>:
// User-prefix scan: <tablePrefix><namespace>:<userPrefix>
//
// The ":" separator may not appear in tablePrefix or namespace (validated),
// but user keys may contain anything — they are only ever matched exactly or by
// prefix within an already-scoped namespace.

import { KvdbConfigError } from "./errors.js";

const SEPARATOR = ":";

export interface KeyScope {
  tablePrefix: string;
  namespace: string;
}

function assertNoSeparator(label: string, segment: string): void {
  if (segment.includes(SEPARATOR)) {
    throw new KvdbConfigError(
      `${label} must not contain "${SEPARATOR}": received ${JSON.stringify(segment)}`,
    );
  }
}

/** The physical prefix that scopes an entire namespace. */
export function namespacePrefix(scope: KeyScope): string {
  assertNoSeparator("tablePrefix", scope.tablePrefix);
  assertNoSeparator("namespace", scope.namespace);
  return `${scope.tablePrefix}${scope.namespace}${SEPARATOR}`;
}

/** Map a user key to its physical key. */
export function toPhysicalKey(scope: KeyScope, userKey: string): string {
  return `${namespacePrefix(scope)}${userKey}`;
}

/** Map a physical key back to its user key (inverse of toPhysicalKey). */
export function toUserKey(scope: KeyScope, physicalKey: string): string {
  const prefix = namespacePrefix(scope);
  return physicalKey.startsWith(prefix)
    ? physicalKey.slice(prefix.length)
    : physicalKey;
}

/** The physical prefix for a user-supplied prefix scan within the namespace. */
export function toPhysicalPrefix(scope: KeyScope, userPrefix: string): string {
  return `${namespacePrefix(scope)}${userPrefix}`;
}
