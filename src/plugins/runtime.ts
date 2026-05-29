// Hook runtime — registers and runs lifecycle hooks (docs/ARCHITECTURE.md §5.5).
//
// Plugins call `on(hook, fn)` during setup; the Table calls `run(hook, payload)`
// at each lifecycle point. Hooks run in registration order and each receives the
// previous hook's (possibly modified) payload — an explicit transform pipeline,
// no hidden state. When no hooks are registered for a name, `run` returns the
// payload unchanged with no overhead.

import type {
  HookName,
  HookFn,
  HookPayloads,
  Plugin,
  PluginContext,
} from "./types.js";

/** Storage type: each hook's payload type is erased at the boundary and the
 *  on()/run() generics restore it. Using a single opaque function type avoids
 *  the union-incompatibility of indexing HookPayloads by a generic. */
type AnyHookFn = (payload: unknown) => unknown | Promise<unknown>;

export class HookRuntime implements PluginContext {
  private readonly hooks = new Map<HookName, AnyHookFn[]>();

  on<N extends HookName>(hook: N, fn: HookFn<N>): void {
    const existing = this.hooks.get(hook);
    if (existing) {
      existing.push(fn as AnyHookFn);
    } else {
      this.hooks.set(hook, [fn as AnyHookFn]);
    }
  }

  register(plugin: Plugin): void {
    plugin.setup(this);
  }

  /** Run all hooks for `hook`, threading the payload through each. */
  async run<N extends HookName>(hook: N, payload: HookPayloads[N]): Promise<HookPayloads[N]> {
    const fns = this.hooks.get(hook);
    if (fns === undefined || fns.length === 0) return payload;
    let current: unknown = payload;
    for (const fn of fns) {
      current = await fn(current);
    }
    return current as HookPayloads[N];
  }

  has(hook: HookName): boolean {
    return (this.hooks.get(hook)?.length ?? 0) > 0;
  }
}
