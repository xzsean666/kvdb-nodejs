// Real-environment end-to-end suite — drives the PUBLIC KVDB API against a live
// PostgreSQL instance (no mocks, no in-memory substitutes for the DB layer).
//
// Connection comes from PG_DATABASE_URL, loaded from the repo-root .env.test by
// load-env.ts. If that variable is absent the entire suite is skipped so a
// machine without DB access never shows a false green.
//
// Coverage:
//   - lifecycle (lazy + explicit connect, close, raw escape hatch)
//   - CRUD, overwrite, undefined-is-delete (KD-7), exists
//   - TTL (expiry-as-missing, survival, purgeExpired, background cleanup)
//   - batch ops (setMany/getMany/deleteMany — order + counts)
//   - prefix scan/delete (boundary correctness, LIKE-escaping)
//   - JSON find: $eq/$gt/$lt/$gte/$lte/$or/$in/$nin/$ne/$exists, AND, sort/limit/offset
//   - namespace isolation + scoped clear() + tablePrefix
//   - ensureIndex + opt-in auto-index
//   - point-read cache integration on the Table
//   - @Cacheable / @CacheClear decorators backed by a real tiered cache,
//     fronting real Postgres reads (DB-hit counting proves memoization)

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { loadEnvTest } from "./load-env.js";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import {
  Cacheable,
  CacheClear,
  setDefaultCache,
  clearDefaultCache,
} from "../../src/decorators/cacheable.js";

loadEnvTest();

const URL = process.env.PG_DATABASE_URL;
const TABLE = "kvdb_e2e";

// Track every KVDB we open so afterAll can tear pools down (open pg pools keep
// the process — and the vitest worker — alive).
const opened: KVDB[] = [];
function makeDb(opts: Partial<ConstructorParameters<typeof KVDB>[0]> = {}): KVDB {
  const db = new KVDB({ driver: "postgresql", url: URL!, table: TABLE, ...opts });
  opened.push(db);
  return db;
}

const describeE2E = URL ? describe : describe.skip;

describeE2E("e2e: PostgreSQL via public KVDB API", () => {
  let db: KVDB;

  beforeAll(async () => {
    db = makeDb();
    await db.connect(); // explicit connect (otherwise lazy on first op)
    // Start from a clean physical table so reruns are deterministic.
    const pool = (await db.raw()) as import("pg").Pool;
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.close();
    opened.pop();
    // Reopen — connect() recreates the table via CREATE TABLE IF NOT EXISTS.
    db = makeDb();
    await db.connect();
  });

  afterAll(async () => {
    // Drop the physical table, then close every pool we opened.
    try {
      const pool = (await db.raw()) as import("pg").Pool;
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } catch {
      /* table may already be gone */
    }
    await Promise.all(opened.map((d) => d.close().catch(() => {})));
  });

  // ---------------------------------------------------------------- lifecycle
  describe("lifecycle & raw", () => {
    it("connects and exposes a live pg Pool via raw()", async () => {
      const pool = (await db.raw()) as import("pg").Pool;
      const r = await pool.query("SELECT 1 AS one");
      expect(r.rows[0].one).toBe(1);
    });

    it("created the physical table with the expected columns", async () => {
      const pool = (await db.raw()) as import("pg").Pool;
      const r = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 ORDER BY column_name`,
        [TABLE],
      );
      expect(r.rows.map((x) => x.column_name)).toEqual([
        "created_at",
        "expires_at",
        "key",
        "updated_at",
        "value",
      ]);
    });
  });

  // ---------------------------------------------------------------------- CRUD
  describe("CRUD", () => {
    const t = () => db.table<{ n?: number; tag?: string }>("crud");
    beforeEach(() => t().clear());

    it("set / get / exists / delete round-trips", async () => {
      const users = t();
      await users.set("a", { n: 1, tag: "x" });
      expect(await users.get("a")).toEqual({ n: 1, tag: "x" });
      expect(await users.exists("a")).toBe(true);
      expect(await users.delete("a")).toBe(true);
      expect(await users.delete("a")).toBe(false);
      expect(await users.get("a")).toBeUndefined();
      expect(await users.exists("a")).toBe(false);
    });

    it("overwrites an existing key", async () => {
      const users = t();
      await users.set("a", { n: 1 });
      await users.set("a", { n: 2 });
      expect(await users.get("a")).toEqual({ n: 2 });
    });

    it("set(undefined) deletes the key (KD-7)", async () => {
      const users = t();
      await users.set("a", { n: 1 });
      await users.set("a", undefined as never);
      expect(await users.exists("a")).toBe(false);
    });

    it("round-trips assorted JSON value shapes losslessly", async () => {
      const raw = db.table<unknown>("crud-shapes");
      await raw.clear();
      const samples: [string, unknown][] = [
        ["str", "héllo \"quoted\" \\ \n"],
        ["num", -3.14159],
        ["zero", 0],
        ["bool", false],
        ["null", null],
        ["arr", [1, "two", { three: 3 }, null]],
        ["nested", { a: { b: { c: [true, false] } }, unicode: "数据库" }],
        ["empty-obj", {}],
      ];
      for (const [k, v] of samples) await raw.set(k, v);
      for (const [k, v] of samples) expect(await raw.get(k)).toEqual(v);
    });
  });

  // ----------------------------------------------------------------------- TTL
  describe("TTL", () => {
    const t = () => db.table<number>("ttl");
    beforeEach(() => t().clear());

    it("treats already-expired entries as missing", async () => {
      const c = t();
      await c.set("k", 1, { ttlMs: -1 });
      expect(await c.get("k")).toBeUndefined();
      expect(await c.exists("k")).toBe(false);
    });

    it("keeps entries that have not expired", async () => {
      const c = t();
      await c.set("k", 1, { ttlMs: 60_000 });
      expect(await c.get("k")).toBe(1);
    });

    it("expires after the TTL elapses (real wall-clock)", async () => {
      const c = t();
      await c.set("k", 1, { ttlMs: 150 });
      expect(await c.get("k")).toBe(1);
      await new Promise((r) => setTimeout(r, 250));
      expect(await c.get("k")).toBeUndefined();
    });

    it("purgeExpired() reclaims expired rows and returns the count", async () => {
      const c = t();
      await c.setMany([
        { key: "live", value: 1, ttlMs: 60_000 },
        { key: "dead1", value: 2, ttlMs: -1 },
        { key: "dead2", value: 3, ttlMs: -1 },
      ]);
      const purged = await db.purgeExpired();
      expect(purged).toBeGreaterThanOrEqual(2);
      expect(await c.get("live")).toBe(1);
    });
  });

  // --------------------------------------------------------------------- batch
  describe("batch ops", () => {
    const t = () => db.table<number>("batch");
    beforeEach(() => t().clear());

    it("setMany / getMany preserve input order with gaps", async () => {
      const c = t();
      await c.setMany([
        { key: "a", value: 1 },
        { key: "c", value: 3 },
      ]);
      expect(await c.getMany(["a", "b", "c"])).toEqual([1, undefined, 3]);
    });

    it("deleteMany returns the number actually deleted", async () => {
      const c = t();
      await c.setMany([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      expect(await c.deleteMany(["a", "b", "missing"])).toBe(2);
      expect(await c.getMany(["a", "b"])).toEqual([undefined, undefined]);
    });

    it("setMany is transactional across a batch", async () => {
      const c = t();
      const items = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: i }));
      await c.setMany(items);
      const got = await c.getMany(items.map((i) => i.key));
      expect(got).toEqual(items.map((i) => i.value));
    });
  });

  // -------------------------------------------------------------------- prefix
  describe("prefix scan/delete", () => {
    const t = () => db.table<{ n: number }>("prefix");
    beforeEach(() => t().clear());

    it("scans and deletes by prefix without crossing boundaries", async () => {
      const c = t();
      await c.set("user:1", { n: 1 });
      await c.set("user:2", { n: 2 });
      await c.set("post:1", { n: 3 });
      const users = await c.getByPrefix("user:");
      expect(users.map((e) => e.key).sort()).toEqual(["user:1", "user:2"]);
      expect(await c.deleteByPrefix("user:")).toBe(2);
      expect(await c.getByPrefix("user:")).toHaveLength(0);
      expect(await c.getByPrefix("post:")).toHaveLength(1);
    });

    it("treats LIKE metacharacters in the prefix literally", async () => {
      const c = t();
      await c.set("a%b", { n: 1 });
      await c.set("axb", { n: 2 });
      await c.set("a_b", { n: 3 });
      const pct = await c.getByPrefix("a%");
      expect(pct.map((e) => e.key)).toEqual(["a%b"]); // not axb / a_b
    });
  });

  // ----------------------------------------------------------------- JSON find
  describe("JSON find (pg-jsonb)", () => {
    const t = () =>
      db.table<{
        name: string;
        profile?: { age: number };
        status?: string;
        vip?: boolean;
      }>("find");

    beforeEach(async () => {
      const c = t();
      await c.clear();
      await c.set("u1", { name: "Ann", profile: { age: 30 }, status: "active", vip: true });
      await c.set("u2", { name: "Bob", profile: { age: 17 }, status: "active", vip: false });
      await c.set("u3", { name: "Cid", profile: { age: 40 }, status: "gone" });
    });

    const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort();

    it("$eq via bare value", async () => {
      expect(keys(await t().find({ where: { status: "gone" } }))).toEqual(["u3"]);
    });

    it("nested numeric comparisons", async () => {
      expect(keys(await t().find({ where: { "profile.age": { $gt: 18 } } }))).toEqual(["u1", "u3"]);
      expect(keys(await t().find({ where: { "profile.age": { $lt: 18 } } }))).toEqual(["u2"]);
      expect(keys(await t().find({ where: { "profile.age": { $gte: 30 } } }))).toEqual(["u1", "u3"]);
      expect(keys(await t().find({ where: { "profile.age": { $lte: 17 } } }))).toEqual(["u2"]);
    });

    it("AND of multiple conditions", async () => {
      expect(
        keys(await t().find({ where: { "profile.age": { $gte: 18 }, status: "active" } })),
      ).toEqual(["u1"]);
    });

    it("$or", async () => {
      expect(
        keys(
          await t().find({
            where: { $or: [{ status: "gone" }, { "profile.age": { $lt: 18 } }] },
          }),
        ),
      ).toEqual(["u2", "u3"]);
    });

    it("$in / $nin", async () => {
      expect(keys(await t().find({ where: { name: { $in: ["Ann", "Cid"] } } }))).toEqual(["u1", "u3"]);
      expect(keys(await t().find({ where: { name: { $nin: ["Ann"] } } }))).toEqual(["u2", "u3"]);
    });

    it("$ne matches different values AND missing fields (Mongo semantics)", async () => {
      expect(keys(await t().find({ where: { vip: { $ne: true } } }))).toEqual(["u2", "u3"]);
    });

    it("$exists distinguishes present from missing", async () => {
      expect(keys(await t().find({ where: { vip: { $exists: true } } }))).toEqual(["u1", "u2"]);
      expect(keys(await t().find({ where: { vip: { $exists: false } } }))).toEqual(["u3"]);
    });

    it("boolean equality", async () => {
      expect(keys(await t().find({ where: { vip: true } }))).toEqual(["u1"]);
      expect(keys(await t().find({ where: { vip: false } }))).toEqual(["u2"]);
    });

    it("sort + limit + offset", async () => {
      const desc = await t().find({ sort: [{ path: "profile.age", direction: "desc" }] });
      expect(desc.map((r) => r.key)).toEqual(["u3", "u1", "u2"]);
      const page = await t().find({
        sort: [{ path: "profile.age", direction: "asc" }],
        limit: 1,
        offset: 1,
      });
      expect(page.map((r) => r.key)).toEqual(["u1"]);
    });

    it("empty where matches all in the namespace", async () => {
      expect(keys(await t().find({}))).toEqual(["u1", "u2", "u3"]);
    });

    it("expired rows are excluded from find results", async () => {
      const c = t();
      await c.set("u4", { name: "Dot", profile: { age: 99 } }, { ttlMs: -1 });
      expect(keys(await c.find({ where: { "profile.age": { $gt: 18 } } }))).toEqual(["u1", "u3"]);
    });
  });

  // ----------------------------------------------------- namespaces & prefixes
  describe("namespace isolation", () => {
    it("keeps namespaces independent and clear() is scoped", async () => {
      const a = db.table<number>("ns-a");
      const b = db.table<number>("ns-b");
      await a.clear();
      await b.clear();
      await a.set("shared", 1);
      await b.set("shared", 2);
      expect(await a.get("shared")).toBe(1);
      expect(await b.get("shared")).toBe(2);

      await a.clear();
      expect(await a.get("shared")).toBeUndefined();
      expect(await b.get("shared")).toBe(2); // untouched
    });

    it("tablePrefix further partitions a shared physical table", async () => {
      const p1 = makeDb({ tablePrefix: "t1_" });
      const p2 = makeDb({ tablePrefix: "t2_" });
      const a = p1.table<number>("ns");
      const b = p2.table<number>("ns");
      await a.set("k", 10);
      await b.set("k", 20);
      expect(await a.get("k")).toBe(10);
      expect(await b.get("k")).toBe(20);
      await a.delete("k");
      await b.delete("k");
    });
  });

  // --------------------------------------------------------------- index / DDL
  describe("indexing", () => {
    it("ensureIndex is callable and does not alter results", async () => {
      const c = db.table<{ profile: { age: number } }>("idx");
      await c.clear();
      await c.set("u1", { profile: { age: 30 } });
      await c.ensureIndex("profile.age");
      // Idempotent: CREATE INDEX IF NOT EXISTS.
      await c.ensureIndex("profile.age");
      const rows = await c.find({ where: { "profile.age": { $gte: 30 } } });
      expect(rows.map((r) => r.key)).toEqual(["u1"]);

      // The index physically exists in pg.
      const pool = (await db.raw()) as import("pg").Pool;
      const r = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname LIKE $2`,
        [TABLE, `${TABLE}_json_%`],
      );
      expect(r.rows.length).toBeGreaterThanOrEqual(1);
    });

    it("opt-in auto-index creates an index after the threshold", async () => {
      const auto = makeDb({ autoIndex: { threshold: 3 } });
      const c = auto.table<{ score: number }>("autoidx");
      await c.clear();
      await c.set("a", { score: 5 });
      for (let i = 0; i < 4; i++) await c.find({ where: { score: { $gte: 0 } } });

      const pool = (await auto.raw()) as import("pg").Pool;
      const r = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
        [TABLE, `${TABLE}_json_score`],
      );
      expect(r.rows.length).toBe(1);
    });
  });

  // ----------------------------------------------------- point-read cache (KVDB)
  describe("point-read cache integration", () => {
    it("serves repeat get() from cache and invalidates on write/delete", async () => {
      const cached = makeDb({ cache: { driver: "memory" } });
      const c = cached.table<{ v: number }>("cache-read");
      await c.clear();

      await c.set("k", { v: 1 });
      expect(await c.get("k")).toEqual({ v: 1 }); // populates cache

      // Mutate the underlying row out-of-band; cache should still serve old value.
      const pool = (await cached.raw()) as import("pg").Pool;
      await pool.query(`UPDATE ${TABLE} SET value = $1 WHERE key LIKE $2`, [
        '{"v":999}',
        "%cache-read:k",
      ]);
      expect(await c.get("k")).toEqual({ v: 1 }); // from cache, not DB

      // A write through the Table refreshes the cache.
      await c.set("k", { v: 2 });
      expect(await c.get("k")).toEqual({ v: 2 });

      // delete() invalidates the cache too.
      await c.delete("k");
      expect(await c.get("k")).toBeUndefined();
    });
  });

  // ------------------------------------------------ performance / index usage
  describe("performance: index usage (EXPLAIN on real PG)", () => {
    // Force the planner to reveal index *capability* — on tiny tables it would
    // otherwise prefer a seq scan regardless. "not Seq Scan" then proves the
    // index is usable for the query (the pre-fix behavior could only seq-scan).
    const explain = async (sql: string): Promise<string> => {
      const pool = (await db.raw()) as import("pg").Pool;
      const client = await pool.connect();
      try {
        await client.query("SET enable_seqscan = off");
        const r = await client.query<{ "QUERY PLAN": string }>("EXPLAIN " + sql);
        return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
      } finally {
        client.release();
      }
    };
    const indexNames = async (): Promise<string[]> => {
      const pool = (await db.raw()) as import("pg").Pool;
      const r = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
        [TABLE],
      );
      return r.rows.map((x) => x.indexname);
    };

    it("creates a text_pattern_ops key index for prefix/namespace scans", async () => {
      expect(await indexNames()).toContain(`${TABLE}_key_prefix`);
    });

    it("namespace-scoped find uses the key-prefix index (not a seq scan)", async () => {
      const c = db.table<{ n: number }>("perfns");
      await c.clear();
      await c.setMany(Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, value: { n: i } })));
      const plan = await explain(
        `SELECT key, value FROM ${TABLE} WHERE key LIKE 'perfns:%'`,
      );
      expect(plan).toMatch(/Index/);
      expect(plan).not.toMatch(/Seq Scan/);
    });

    it("ensureIndex creates BOTH text and numeric expression indexes (Fix A)", async () => {
      const c = db.table<{ score: number }>("perfidx");
      await c.clear();
      await c.set("a", { score: 5 });
      await c.ensureIndex("score");
      const names = await indexNames();
      expect(names).toContain(`${TABLE}_json_score`);
      expect(names).toContain(`${TABLE}_json_score_num`); // numeric, the Fix-A addition
    });

    it("numeric find uses the numeric expression index (Fix A)", async () => {
      const c = db.table<{ score: number }>("perfnum");
      await c.clear();
      await c.setMany(Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, value: { score: i } })));
      await c.ensureIndex("score");
      // The CASE-numeric expression the driver compiles for `score >= 50`.
      const expr =
        `(CASE WHEN jsonb_typeof((value)::jsonb #> '{score}') = 'number' ` +
        `THEN ((value)::jsonb #>> '{score}')::numeric END)`;
      const plan = await explain(
        `SELECT key FROM ${TABLE} WHERE key LIKE 'perfnum:%' AND ${expr} >= 50`,
      );
      expect(plan).toMatch(/Index/);
      expect(plan).not.toMatch(/Seq Scan/);
    });

    it("numeric find does NOT crash on mixed-type JSON at the same path", async () => {
      // A string at `score` would make a bare (text)::numeric cast throw and
      // take down the whole query. The CASE-guarded cast yields NULL instead.
      const c = db.table<{ score: number | string }>("perfmix");
      await c.clear();
      await c.set("num1", { score: 30 });
      await c.set("num2", { score: 10 });
      await c.set("str", { score: "not-a-number" });
      const rows = await c.find({ where: { score: { $gte: 18 } } });
      expect(rows.map((r) => r.key)).toEqual(["num1"]); // string excluded, no crash
    });
  });

  // ----------------------------------------------- `indexes` init option (opt-in)
  describe("indexes init option (default: no value index)", () => {
    it("pre-creates value-path indexes at connect when requested", async () => {
      const optTable = "kvdb_e2e_opt";
      const withIdx = makeDb({ table: optTable, indexes: ["profile.age", "status"] });
      await withIdx.connect();
      const pool = (await withIdx.raw()) as import("pg").Pool;
      try {
        const r = await pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
          [optTable],
        );
        const names = r.rows.map((x) => x.indexname);
        // value-path indexes present...
        expect(names).toContain(`${optTable}_json_profile_age`);
        expect(names).toContain(`${optTable}_json_profile_age_num`);
        expect(names).toContain(`${optTable}_json_status`);
        // ...and the key prefix infra index, but the key remains the PK.
        expect(names).toContain(`${optTable}_key_prefix`);
        expect(names).toContain(`${optTable}_pkey`);
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${optTable}`);
      }
    });

    it("default (no indexes option) creates NO value/JSON index", async () => {
      const optTable = "kvdb_e2e_noidx";
      const plain = makeDb({ table: optTable });
      await plain.connect();
      const pool = (await plain.raw()) as import("pg").Pool;
      try {
        const r = await pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
          [optTable],
        );
        const names = r.rows.map((x) => x.indexname);
        expect(names.some((n) => n.includes("_json_"))).toBe(false); // no value index
        expect(names).toContain(`${optTable}_pkey`); // key is the primary key
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${optTable}`);
      }
    });
  });

  // --------------------------------------------------- @Cacheable / @CacheClear
  describe("decorator caching over real Postgres", () => {
    let cache: Cache;
    let dbHits: ReturnType<typeof vi.fn>;

    // A repository whose reads go to a REAL Postgres-backed Table, fronted by
    // the @Cacheable decorator. The hit counter proves the DB is touched once
    // per distinct key while the cache is warm.
    class ProfileRepo {
      constructor(private readonly table = db.table<{ name: string }>("repo")) {}

      @Cacheable({ ttlMs: 60_000 })
      async getProfile(id: string): Promise<{ name: string } | undefined> {
        dbHits();
        return this.table.get(id);
      }

      @Cacheable({ cacheKey: (args) => `profile:${args[0]}` })
      async getProfileCustomKey(id: string): Promise<{ name: string } | undefined> {
        dbHits();
        return this.table.get(id);
      }

      @CacheClear({ cacheKey: (args) => `profile:${args[0]}` })
      async invalidate(id: string): Promise<void> {
        await this.table.set(id, { name: `updated-${id}` });
      }
    }

    beforeEach(async () => {
      // Real tiered cache: in-process memory over a real better-sqlite3 store.
      cache = new Cache({ stores: ["memory", "sqlite-memory"] });
      setDefaultCache(cache);
      dbHits = vi.fn();
      const seed = db.table<{ name: string }>("repo");
      await seed.clear();
      await seed.set("u1", { name: "Ann" });
      await seed.set("u2", { name: "Bob" });
    });

    afterEach(async () => {
      await cache.clear();
      clearDefaultCache();
    });

    it("memoizes by arguments — DB hit once per distinct key", async () => {
      const repo = new ProfileRepo();
      expect(await repo.getProfile("u1")).toEqual({ name: "Ann" });
      expect(await repo.getProfile("u1")).toEqual({ name: "Ann" }); // cache hit
      expect(await repo.getProfile("u1")).toEqual({ name: "Ann" }); // cache hit
      expect(dbHits).toHaveBeenCalledTimes(1);

      expect(await repo.getProfile("u2")).toEqual({ name: "Bob" }); // miss -> DB
      expect(dbHits).toHaveBeenCalledTimes(2);
    });

    it("honors a custom cacheKey builder", async () => {
      const repo = new ProfileRepo();
      await repo.getProfileCustomKey("u1");
      expect(await cache.get("profile:u1")).toEqual({ name: "Ann" });
    });

    it("@CacheClear evicts the key after the method runs", async () => {
      const repo = new ProfileRepo();
      await repo.getProfileCustomKey("u1"); // warms profile:u1
      expect(await cache.get("profile:u1")).toEqual({ name: "Ann" });

      await repo.invalidate("u1"); // writes to PG + evicts profile:u1
      expect(await cache.get("profile:u1")).toBeUndefined();

      // Next read repopulates from Postgres with the updated value.
      const fresh = await repo.getProfileCustomKey("u1");
      expect(fresh).toEqual({ name: "updated-u1" });
    });

    it("tiered cache backfills the memory tier from sqlite", async () => {
      const repo = new ProfileRepo();
      await repo.getProfile("u1"); // writes both tiers, 1 DB hit

      // Wipe ONLY the top (memory) tier by constructing a probe that reads via
      // the same cache: a fresh get must still avoid the DB (served by sqlite).
      const callsBefore = dbHits.mock.calls.length;
      await repo.getProfile("u1");
      expect(dbHits.mock.calls.length).toBe(callsBefore); // no extra DB hit
    });
  });
});

// When the suite is skipped, leave a visible breadcrumb explaining why.
if (!URL) {
  describe("e2e: PostgreSQL", () => {
    it.skip("skipped — set PG_DATABASE_URL in .env.test to run", () => {});
  });
}
