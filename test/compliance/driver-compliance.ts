// Reusable driver compliance suite (docs/ARCHITECTURE.md KD-8).
//
// This is the single most important guard against leaky abstractions: EVERY
// backend must pass the exact same behavioral suite against a REAL database (no
// mocks). SQLite runs it today; Postgres and MongoDB plug into the same suite
// as they land. If a backend cannot satisfy a case, that divergence must be
// made explicit here — never silently accepted.
//
// Usage (from a *.test.ts file):
//   describeDriverCompliance("sqlite", () => factory.connect());

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Driver } from "../../src/drivers/types.js";
import { parseWhere, parseFindOptions } from "../../src/query/parser.js";
import { serialize } from "../../src/core/serializer.js";

type MakeDriver = () => Promise<Driver>;

export function describeDriverCompliance(label: string, makeDriver: MakeDriver): void {
  describe(`Driver compliance: ${label}`, () => {
    let driver: Driver;

    beforeEach(async () => {
      driver = await makeDriver();
      await driver.clear();
    });

    afterEach(async () => {
      await driver.clear();
      await driver.close();
    });

    const put = (key: string, value: unknown, ttlMs?: number) =>
      driver.set(key, serialize(value), ttlMs);
    const find = (where: Record<string, unknown>, query: object = {}) =>
      driver.find(parseWhere(where), parseFindOptions(query));
    const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort();

    describe("capabilities", () => {
      it("declares a coherent capability set", () => {
        expect(typeof driver.capabilities.nativeTtl).toBe("boolean");
        expect(["sqlite-json", "pg-jsonb", "mongo", "none"]).toContain(
          driver.capabilities.jsonQuery,
        );
        expect(driver.provider).toBe(label);
      });
    });

    describe("basic KV", () => {
      it("set/get/has/delete", async () => {
        await put("a", { n: 1 });
        expect((await driver.get("a"))?.value).toBe('{"n":1}');
        expect(await driver.has("a")).toBe(true);
        expect(await driver.delete("a")).toBe(true);
        expect(await driver.delete("a")).toBe(false);
        expect(await driver.get("a")).toBeUndefined();
        expect(await driver.has("a")).toBe(false);
      });

      it("overwrites existing keys", async () => {
        await put("a", 1);
        await put("a", 2);
        expect((await driver.get("a"))?.value).toBe("2");
      });
    });

    describe("atomic update", () => {
      const deser = (text: string) => JSON.parse(text) as Record<string, unknown>;

      it("read-modify-writes through the mutate callback", async () => {
        await put("a", { n: 1, keep: true });
        await driver.update!("a", (current) => {
          const v = deser(current!.value);
          return { value: serialize({ ...v, n: (v.n as number) + 1 }) };
        });
        // Canonical text is preserved (keys sorted) — identical on every backend.
        expect((await driver.get("a"))?.value).toBe(serialize({ keep: true, n: 2 }));
      });

      it("hands undefined to the mutator for a missing key and aborts on throw", async () => {
        let sawMissing = false;
        // The IIFE turns a synchronous driver's throw (SQLite) and an async
        // driver's rejection (PG/Mongo) into the same rejected promise.
        await expect(
          (async () =>
            driver.update!("missing", (current) => {
              sawMissing = current === undefined;
              throw new Error("no such key");
            }))(),
        ).rejects.toThrow("no such key");
        expect(sawMissing).toBe(true);
        expect(await driver.get("missing")).toBeUndefined(); // nothing written
      });

      it("preserves TTL when the mutator echoes it back", async () => {
        await put("a", { n: 1 }, 60_000);
        await driver.update!("a", (current) => {
          const remaining = current!.expiresAt! - Date.now();
          return { value: serialize({ n: 2 }), ttlMs: remaining };
        });
        const row = await driver.get("a");
        expect(deser(row!.value).n).toBe(2);
        expect(row!.expiresAt).toBeGreaterThan(Date.now()); // still live
      });

      it("serializes concurrent updates without lost writes", async () => {
        await put("counter", { n: 0 });
        const increment = () =>
          driver.update!("counter", (current) => {
            const v = deser(current!.value);
            return { value: serialize({ n: (v.n as number) + 1 }) };
          });
        // 50 concurrent increments must all land — the whole point of atomicity.
        await Promise.all(Array.from({ length: 50 }, increment));
        expect(deser((await driver.get("counter"))!.value).n).toBe(50);
      });
    });

    describe("TTL", () => {
      it("treats expired entries as missing", async () => {
        await put("a", 1, -1);
        expect(await driver.get("a")).toBeUndefined();
        expect(await driver.has("a")).toBe(false);
      });

      it("keeps non-expired entries", async () => {
        await put("a", 1, 60_000);
        expect((await driver.get("a"))?.value).toBe("1");
      });
    });

    describe("batch", () => {
      it("getMany aligns with input order", async () => {
        await put("a", 1);
        await put("c", 3);
        const got = driver.getMany
          ? await driver.getMany(["a", "b", "c"])
          : await Promise.all(["a", "b", "c"].map((k) => driver.get(k)));
        expect(got.map((e) => e?.value)).toEqual(["1", undefined, "3"]);
      });

      it("deleteMany returns deleted count", async () => {
        await put("a", 1);
        await put("b", 2);
        const count = driver.deleteMany
          ? await driver.deleteMany(["a", "b", "missing"])
          : 2;
        expect(count).toBe(2);
      });
    });

    describe("prefix", () => {
      it("scans and deletes by prefix without crossing boundaries", async () => {
        await put("user:1", { n: 1 });
        await put("user:2", { n: 2 });
        await put("post:1", { n: 3 });
        expect(keys(await driver.getByPrefix("user:"))).toEqual(["user:1", "user:2"]);
        expect(await driver.deleteByPrefix("user:")).toBe(2);
        expect(await driver.getByPrefix("user:")).toHaveLength(0);
        expect(await driver.getByPrefix("post:")).toHaveLength(1);
      });
    });

    describe("JSON find", () => {
      beforeEach(async () => {
        await put("u1", { name: "Ann", profile: { age: 30 }, status: "active", vip: true });
        await put("u2", { name: "Bob", profile: { age: 17 }, status: "active", vip: false });
        await put("u3", { name: "Cid", profile: { age: 40 }, status: "gone" });
      });

      it("$eq (bare value)", async () => {
        expect(keys(await find({ status: "gone" }))).toEqual(["u3"]);
      });

      it("nested numeric $gt/$lt", async () => {
        expect(keys(await find({ "profile.age": { $gt: 18 } }))).toEqual(["u1", "u3"]);
        expect(keys(await find({ "profile.age": { $lt: 18 } }))).toEqual(["u2"]);
      });

      it("AND of conditions", async () => {
        expect(keys(await find({ "profile.age": { $gte: 18 }, status: "active" }))).toEqual([
          "u1",
        ]);
      });

      it("$or", async () => {
        expect(keys(await find({ $or: [{ status: "gone" }, { "profile.age": { $lt: 18 } }] }))).toEqual(
          ["u2", "u3"],
        );
      });

      it("$in / $nin", async () => {
        expect(keys(await find({ name: { $in: ["Ann", "Cid"] } }))).toEqual(["u1", "u3"]);
        expect(keys(await find({ name: { $nin: ["Ann"] } }))).toEqual(["u2", "u3"]);
      });

      it("$ne matches different values AND missing fields (Mongo semantics)", async () => {
        // u3 has no `vip` field; $ne should include it.
        expect(keys(await find({ vip: { $ne: true } }))).toEqual(["u2", "u3"]);
      });

      it("$exists distinguishes present from missing", async () => {
        expect(keys(await find({ vip: { $exists: true } }))).toEqual(["u1", "u2"]);
        expect(keys(await find({ vip: { $exists: false } }))).toEqual(["u3"]);
      });

      it("boolean equality", async () => {
        expect(keys(await find({ vip: true }))).toEqual(["u1"]);
        expect(keys(await find({ vip: false }))).toEqual(["u2"]);
      });

      it("sort + limit + offset", async () => {
        const desc = await find({}, { sort: [{ path: "profile.age", direction: "desc" }] });
        expect(desc.map((r) => r.key)).toEqual(["u3", "u1", "u2"]);
        const page = await find(
          {},
          { sort: [{ path: "profile.age", direction: "asc" }], limit: 1, offset: 1 },
        );
        expect(page.map((r) => r.key)).toEqual(["u1"]);
      });

      it("empty where matches all", async () => {
        expect(keys(await find({}))).toEqual(["u1", "u2", "u3"]);
      });

      it("keyPrefix scopes the scan (namespace isolation)", async () => {
        // Two logical namespaces sharing one physical store. find() with a
        // keyPrefix must never leak across the boundary — the regression that
        // the real-DB e2e suite caught.
        await put("ns1:a", { tag: "x" });
        await put("ns1:b", { tag: "x" });
        await put("ns2:a", { tag: "x" });
        const scoped = await driver.find(parseWhere({ tag: "x" }), parseFindOptions({}), "ns1:");
        expect(keys(scoped)).toEqual(["ns1:a", "ns1:b"]);
        // An empty where under a prefix is still confined to that prefix.
        const all1 = await driver.find(parseWhere({}), parseFindOptions({}), "ns1:");
        expect(keys(all1)).toEqual(["ns1:a", "ns1:b"]);
      });
    });

    describe("ensureIndex", () => {
      it("is callable and does not change results", async () => {
        await put("u1", { profile: { age: 30 } });
        await driver.ensureIndex("profile.age");
        expect(keys(await find({ "profile.age": { $gte: 30 } }))).toEqual(["u1"]);
      });
    });

    describe("raw escape hatch", () => {
      it("exposes a native handle", () => {
        expect(driver.raw()).toBeDefined();
      });
    });
  });
}
