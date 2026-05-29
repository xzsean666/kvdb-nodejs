// Real-environment e2e for the FILE-backed SQLite driver (not :memory:).
//
// The unit/compliance suites use ":memory:", which cannot show the property that
// matters most for an on-disk database: durability. Here every assertion uses a
// real file in a temp dir — data, indexes, and TTL must survive close()/reopen,
// WAL files must appear, and two KVDB instances over the same file must see each
// other's writes. The temp dir (and its -wal/-shm sidecars) is removed at the end.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import { SqliteCacheStore } from "../../src/cache/stores/sqlite-store.js";

describe("e2e: file-backed SQLite (durability on real disk)", () => {
  let dir: string;
  let file: string;
  const opened: KVDB[] = [];

  const open = (opts: Partial<ConstructorParameters<typeof KVDB>[0]> = {}): KVDB => {
    const db = new KVDB({ driver: "sqlite", url: file, ...opts });
    opened.push(db);
    return db;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kvdb-file-e2e-"));
    file = join(dir, "kvdb.sqlite");
  });

  afterAll(async () => {
    await Promise.all(opened.map((d) => d.close().catch(() => {})));
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the database file on disk and runs in WAL mode", async () => {
    const db = open();
    await db.table<number>("init").set("k", 1);
    expect(existsSync(file)).toBe(true);
    const raw = (await db.raw()) as Database;
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    // WAL sidecar files exist while the connection is open.
    expect(readdirSync(dir).some((f) => f.endsWith("-wal"))).toBe(true);
    await db.close();
    opened.pop();
  });

  it("persists values across close() and reopen (durability)", async () => {
    const first = new KVDB({ driver: "sqlite", url: file });
    const users = first.table<{ name: string; age: number }>("users");
    await users.set("u1", { name: "Ann", age: 30 });
    await users.setMany([
      { key: "u2", value: { name: "Bob", age: 17 } },
      { key: "u3", value: { name: "Cid", age: 40 } },
    ]);
    await first.close(); // flush + release the file

    // A brand-new instance over the same path must see the data.
    const second = open();
    const reread = second.table<{ name: string; age: number }>("users");
    expect(await reread.get("u1")).toEqual({ name: "Ann", age: 30 });
    expect((await reread.getMany(["u2", "u3"])).map((v) => v?.name)).toEqual(["Bob", "Cid"]);
  });

  it("persists a JSON index across reopen and keeps queries working", async () => {
    // Declare an index at init; it is written into the file's schema.
    const writer = new KVDB({ driver: "sqlite", url: file, indexes: ["age"] });
    const t = writer.table<{ name: string; age: number }>("members");
    await t.clear();
    await t.setMany([
      { key: "a", value: { name: "A", age: 20 } },
      { key: "b", value: { name: "B", age: 50 } },
    ]);
    await writer.close();

    const reader = open();
    // The index is in the persisted schema (sqlite_master).
    const raw = (await reader.raw()) as Database;
    const indexes = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kvdb_kv'`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("kvdb_kv_json_age");

    // And the query still returns correct results from the file.
    const found = await reader.table<{ name: string; age: number }>("members").find({
      where: { age: { $gte: 30 } },
    });
    expect(found.map((r) => r.key)).toEqual(["b"]);
  });

  it("persists TTL: unexpired survives reopen, expired is gone", async () => {
    const writer = new KVDB({ driver: "sqlite", url: file });
    const sess = writer.table<number>("sessions");
    await sess.clear();
    await sess.set("live", 1, { ttlMs: 60_000 }); // long
    await sess.set("dead", 2, { ttlMs: 50 }); // will expire
    await writer.close();

    await new Promise((r) => setTimeout(r, 120)); // let "dead" expire on disk

    const reader = open();
    const reread = reader.table<number>("sessions");
    expect(await reread.get("live")).toBe(1); // survived
    expect(await reread.get("dead")).toBeUndefined(); // expired across reopen
  });

  it("lets two instances over the same file share data live", async () => {
    const a = open();
    const b = open();
    const ta = a.table<string>("shared");
    const tb = b.table<string>("shared");

    await ta.set("k", "written-by-a");
    expect(await tb.get("k")).toBe("written-by-a"); // b sees a's write

    await tb.set("k", "updated-by-b");
    expect(await ta.get("k")).toBe("updated-by-b"); // a sees b's update
  });

  it("supports a file-backed cache store that survives re-instantiation", async () => {
    const cacheFile = join(dir, "cache.sqlite");

    // Write through one Cache instance...
    const c1 = new Cache({ stores: [{ driver: "sqlite", file: cacheFile }] });
    await c1.set("report", { rows: 42 }, 60_000);
    expect(existsSync(cacheFile)).toBe(true);

    // ...and read it back through a fresh Cache over the same file.
    const c2 = new Cache({ stores: [{ driver: "sqlite", file: cacheFile }] });
    expect(await c2.get("report")).toEqual({ rows: 42 });

    // The store is also usable directly.
    const store = new SqliteCacheStore({ file: cacheFile });
    expect(store.get("report")?.value).toBe('{"rows":42}');
  });
});
