// Runs the shared driver compliance suite against a real Redis instance.
//
// Skipped unless KVDB_TEST_REDIS_URL is set (no DB available -> no false green).
// Start one with: docker run --rm -p 6379:6379 redis:8-alpine
// then: KVDB_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test:compliance

import { describe } from "vitest";
import { describeDriverCompliance } from "./driver-compliance.js";
import { RedisDriverFactory } from "../../src/drivers/redis/redis-driver.js";

const url = process.env.KVDB_TEST_REDIS_URL;

if (url) {
  describeDriverCompliance("redis", () =>
    new RedisDriverFactory({ url, keyPrefix: "kvdb_compliance:" }).connect(),
  );
} else {
  describe.skip("Driver compliance: redis (set KVDB_TEST_REDIS_URL to run)", () => {});
}
