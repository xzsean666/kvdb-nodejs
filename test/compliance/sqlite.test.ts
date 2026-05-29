// Runs the shared driver compliance suite against a real (in-memory) SQLite DB.
// Postgres and MongoDB will add sibling files that call the same suite.

import { describeDriverCompliance } from "./driver-compliance.js";
import { SqliteDriverFactory } from "../../src/drivers/sqlite/sqlite-driver.js";

describeDriverCompliance("sqlite", () =>
  new SqliteDriverFactory({ url: ":memory:" }).connect(),
);
