// Plugin / Hook contracts — the extension system (docs/ARCHITECTURE.md §5.5, §7).
//
// Plugins register lifecycle hooks without modifying the core. Hooks observe and
// may rewrite an operation's payload. Behavior stays explicit: a hook receives a
// payload and returns a (possibly modified) payload — no hidden global state.

import type { JsonValue, MaybePromise } from "../types/json.js";
import type { QueryNode, FindOptions } from "../query/ast.js";

export type HookName =
  | "beforeWrite"
  | "afterWrite"
  | "beforeRead"
  | "afterRead"
  | "beforeQuery"
  | "afterQuery";

export interface WritePayload {
  namespace: string;
  key: string;
  value: JsonValue;
  ttlMs?: number;
}

export interface ReadPayload {
  namespace: string;
  key: string;
  value: JsonValue | undefined;
}

export interface QueryPayload {
  namespace: string;
  where: QueryNode;
  options?: FindOptions;
}

/** Map each hook name to the payload type it operates on. */
export interface HookPayloads {
  beforeWrite: WritePayload;
  afterWrite: WritePayload;
  beforeRead: ReadPayload;
  afterRead: ReadPayload;
  beforeQuery: QueryPayload;
  afterQuery: QueryPayload;
}

export type HookFn<N extends HookName> = (
  payload: HookPayloads[N],
) => MaybePromise<HookPayloads[N]>;

/** Surface a plugin uses during setup to register hooks (and later: drivers, cache stores). */
export interface PluginContext {
  on<N extends HookName>(hook: N, fn: HookFn<N>): void;
}

export interface Plugin {
  name: string;
  setup(context: PluginContext): void;
}
