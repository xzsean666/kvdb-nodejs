import { describe, it, expect, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { HookRuntime } from "../../src/plugins/runtime.js";
import type { Plugin } from "../../src/plugins/types.js";

let db: KVDB;
afterEach(async () => {
  await db?.close();
});

describe("HookRuntime", () => {
  it("threads payload through hooks in order", async () => {
    const runtime = new HookRuntime();
    runtime.on("beforeWrite", (p) => ({ ...p, value: (p.value as number) + 1 }));
    runtime.on("beforeWrite", (p) => ({ ...p, value: (p.value as number) * 10 }));
    const result = await runtime.run("beforeWrite", {
      namespace: "n",
      key: "k",
      value: 1,
    });
    expect(result.value).toBe(20); // (1 + 1) * 10
  });

  it("returns payload unchanged when no hooks", async () => {
    const runtime = new HookRuntime();
    const payload = { namespace: "n", key: "k", value: 5 };
    expect(await runtime.run("beforeWrite", payload)).toBe(payload);
    expect(runtime.has("beforeWrite")).toBe(false);
  });
});

describe("KVDB with plugins", () => {
  it("fires beforeWrite (mutating value) and afterRead", async () => {
    const writes: string[] = [];
    const plugin: Plugin = {
      name: "test",
      setup(ctx) {
        ctx.on("beforeWrite", (p) => {
          writes.push(p.key);
          return { ...p, value: { ...(p.value as object), stamped: true } };
        });
        ctx.on("afterRead", (p) =>
          p.value === undefined ? p : { ...p, value: { ...(p.value as object), read: true } },
        );
      },
    };
    db = new KVDB({ driver: "sqlite", url: ":memory:", plugins: [plugin] });
    const t = db.table<Record<string, unknown>>("things");
    await t.set("a", { n: 1 });
    expect(writes).toEqual(["a"]);
    const value = await t.get("a");
    expect(value).toEqual({ n: 1, stamped: true, read: true });
  });
});
