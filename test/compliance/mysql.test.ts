// Runs the shared driver compliance suite against a real MySQL / MariaDB instance.
//
// Skipped unless KVDB_TEST_MYSQL_URL is set (no DB available -> no false green).
// Start one with: docker run --rm -e MARIADB_ROOT_PASSWORD=kvdb_test -p 3307:3306 mariadb:11
// then: KVDB_TEST_MYSQL_URL=mysql://root:kvdb_test@127.0.0.1:3307/kvdb_test pnpm test:compliance

import { describe } from "vitest";
import { describeDriverCompliance } from "./driver-compliance.js";
import { describeMultiKeyCompliance } from "./multikey-compliance.js";
import { MysqlDriverFactory } from "../../src/drivers/mysql/mysql-driver.js";

const url = process.env.KVDB_TEST_MYSQL_URL;

if (url) {
  describeDriverCompliance("mysql", () =>
    new MysqlDriverFactory({ url, table: "kvdb_compliance" }).connect(),
  );
  describeMultiKeyCompliance("mysql", () =>
    new MysqlDriverFactory({ url, table: "kvdb_compliance" }).connect(),
  );
} else {
  describe.skip("Driver compliance: mysql (set KVDB_TEST_MYSQL_URL to run)", () => {});
}
