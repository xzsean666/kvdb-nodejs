import { describe, it, expect } from "vitest";
import {
  namespacePrefix,
  toPhysicalKey,
  toUserKey,
  toPhysicalPrefix,
} from "../../src/core/key.js";
import { KvdbConfigError } from "../../src/core/errors.js";

const scope = { tablePrefix: "app_", namespace: "users" };

describe("key resolution", () => {
  it("builds the namespace prefix", () => {
    expect(namespacePrefix(scope)).toBe("app_users:");
  });

  it("builds physical keys", () => {
    expect(toPhysicalKey(scope, "u1")).toBe("app_users:u1");
  });

  it("round-trips user <-> physical keys", () => {
    const physical = toPhysicalKey(scope, "u1");
    expect(toUserKey(scope, physical)).toBe("u1");
  });

  it("allows ':' inside user keys", () => {
    const physical = toPhysicalKey(scope, "a:b:c");
    expect(physical).toBe("app_users:a:b:c");
    expect(toUserKey(scope, physical)).toBe("a:b:c");
  });

  it("builds physical prefixes for scans", () => {
    expect(toPhysicalPrefix(scope, "admin_")).toBe("app_users:admin_");
  });

  it("works with an empty table prefix", () => {
    expect(toPhysicalKey({ tablePrefix: "", namespace: "cache" }, "k")).toBe("cache:k");
  });

  it("rejects a separator in namespace", () => {
    expect(() => namespacePrefix({ tablePrefix: "", namespace: "a:b" })).toThrow(
      KvdbConfigError,
    );
  });

  it("rejects a separator in tablePrefix", () => {
    expect(() => namespacePrefix({ tablePrefix: "x:", namespace: "n" })).toThrow(
      KvdbConfigError,
    );
  });
});
