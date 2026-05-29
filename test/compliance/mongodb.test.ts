// Runs the shared driver compliance suite against a real MongoDB instance.
//
// Skipped unless KVDB_TEST_MONGO_URL is set (no DB available -> no false green).
// Start one with: docker run --rm -p 27017:27017 mongo:7
// then: KVDB_TEST_MONGO_URL=mongodb://localhost:27017/kvdb_test pnpm test:compliance

import { describe } from "vitest";
import { describeDriverCompliance } from "./driver-compliance.js";
import { MongoDriverFactory } from "../../src/drivers/mongodb/mongodb-driver.js";

const url = process.env.KVDB_TEST_MONGO_URL;

if (url) {
  describeDriverCompliance("mongodb", () =>
    new MongoDriverFactory({ url, collection: "kvdb_compliance" }).connect(),
  );
} else {
  describe.skip("Driver compliance: mongodb (set KVDB_TEST_MONGO_URL to run)", () => {});
}
