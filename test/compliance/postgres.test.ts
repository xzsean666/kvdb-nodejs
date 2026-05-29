// Runs the shared driver compliance suite against a real PostgreSQL instance.
//
// Skipped unless KVDB_TEST_PG_URL is set (no DB available -> no false green).
// Start one with: docker run --rm -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17
// then: KVDB_TEST_PG_URL=postgres://postgres:dev@localhost:5432/postgres pnpm test:compliance

import { describe } from "vitest";
import { describeDriverCompliance } from "./driver-compliance.js";
import { PostgresDriverFactory } from "../../src/drivers/postgres/postgres-driver.js";

const url = process.env.KVDB_TEST_PG_URL;

if (url) {
  describeDriverCompliance("postgres", () =>
    new PostgresDriverFactory({ url, table: "kvdb_compliance" }).connect(),
  );
} else {
  describe.skip("Driver compliance: postgres (set KVDB_TEST_PG_URL to run)", () => {});
}
