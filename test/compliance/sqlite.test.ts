import { describeDriverCompliance } from "./driver-compliance.js";
import { describeMultiKeyCompliance } from "./multikey-compliance.js";
import { SqliteDriverFactory } from "../../src/drivers/sqlite/sqlite-driver.js";

describeDriverCompliance("sqlite", () =>
  new SqliteDriverFactory({ url: ":memory:" }).connect(),
);

describeMultiKeyCompliance("sqlite", () =>
  new SqliteDriverFactory({ url: ":memory:" }).connect(),
);

