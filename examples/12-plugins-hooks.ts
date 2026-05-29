// 12 — Plugins and lifecycle hooks.
//
// Run:  pnpm example examples/12-plugins-hooks.ts
//
// A plugin registers hooks that observe — and may rewrite — an operation's
// payload. Hooks fire on every Table op: beforeWrite/afterWrite,
// beforeRead/afterRead, beforeQuery/afterQuery. This is how you add
// cross-cutting behavior (audit logs, validation, field defaults) without
// touching the core.

import { KVDB } from "kvdb-sdk";
import type { Plugin } from "kvdb-sdk";

// A plugin that timestamps every written object and logs reads.
const auditPlugin: Plugin = {
  name: "audit",
  setup(ctx) {
    ctx.on("beforeWrite", (payload) => {
      // Rewrite the value: stamp an updatedAt field before it is stored.
      if (payload.value && typeof payload.value === "object" && !Array.isArray(payload.value)) {
        payload.value = { ...payload.value, updatedAt: "2026-05-29T00:00:00Z" };
      }
      console.log(`[audit] write ${payload.namespace}:${payload.key}`);
      return payload;
    });
    ctx.on("afterRead", (payload) => {
      console.log(`[audit] read  ${payload.namespace}:${payload.key} -> hit=${payload.value !== undefined}`);
      return payload;
    });
    ctx.on("beforeQuery", (payload) => {
      console.log(`[audit] query ${payload.namespace}`);
      return payload;
    });
  },
};

const db = new KVDB({ driver: "sqlite", plugins: [auditPlugin] });
const docs = db.table<{ title: string; updatedAt?: string }>("docs");

await docs.set("d1", { title: "Draft" });
console.log("stored value:", await docs.get("d1")); // includes updatedAt from the hook
await docs.find({ where: { title: "Draft" } });

await db.close();
