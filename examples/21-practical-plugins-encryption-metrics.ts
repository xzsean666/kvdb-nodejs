// 21 — Real-World Plugins: Telemetry Metrics & Transparent Data Encryption.
//
// Run:  pnpm example examples/21-practical-plugins-encryption-metrics.ts
//
// KVDB's plugin architecture allows non-invasive extensions through lifecycle hooks:
// `beforeWrite`, `afterWrite`, `beforeRead`, `afterRead`, `beforeQuery`, `afterQuery`.
//
// This example builds two production-grade plugins:
// 1. Performance Metrics Plugin: measures operation latency and counters.
// 2. Sensitive Field Encryption Plugin: transparently encrypts secrets before
//    they hit the database, and decrypts them on read.

import { KVDB, type Plugin } from "kvdb-sdk";

// =========================================================================
// Plugin 1: Performance & Telemetry Metrics Plugin
// =========================================================================
interface MetricsData {
  writes: number;
  reads: number;
  totalWriteLatencyMs: number;
  totalReadLatencyMs: number;
}

function createMetricsPlugin(): { plugin: Plugin; getMetrics: () => MetricsData } {
  const metrics: MetricsData = {
    writes: 0,
    reads: 0,
    totalWriteLatencyMs: 0,
    totalReadLatencyMs: 0,
  };

  const startTimes = new Map<string, number>();

  const plugin: Plugin = {
    name: "telemetry-metrics",
    setup(context) {
      context.on("beforeWrite", (payload) => {
        startTimes.set(`w:${payload.namespace}:${payload.key}`, performance.now());
        return payload;
      });

      context.on("afterWrite", (payload) => {
        const start = startTimes.get(`w:${payload.namespace}:${payload.key}`);
        if (start !== undefined) {
          metrics.totalWriteLatencyMs += performance.now() - start;
          startTimes.delete(`w:${payload.namespace}:${payload.key}`);
        }
        metrics.writes++;
        return payload;
      });

      context.on("beforeRead", (payload) => {
        startTimes.set(`r:${payload.namespace}:${payload.key}`, performance.now());
        return payload;
      });

      context.on("afterRead", (payload) => {
        const start = startTimes.get(`r:${payload.namespace}:${payload.key}`);
        if (start !== undefined) {
          metrics.totalReadLatencyMs += performance.now() - start;
          startTimes.delete(`r:${payload.namespace}:${payload.key}`);
        }
        metrics.reads++;
        return payload;
      });
    },
  };

  return { plugin, getMetrics: () => ({ ...metrics }) };
}

// =========================================================================
// Plugin 2: Transparent Secret Field Masking / Encryption Plugin
// =========================================================================
// Simple reversible cipher for demonstration purposes (in production use node:crypto AES-256-GCM)
function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (c) =>
    String.fromCharCode(
      c.charCodeAt(0) + (c.toLowerCase() <= "m" ? 13 : -13),
    ),
  );
}

function createEncryptionPlugin(secretFields: string[]): Plugin {
  return {
    name: "field-encryption",
    setup(context) {
      context.on("beforeWrite", (payload) => {
        if (payload.value && typeof payload.value === "object" && !Array.isArray(payload.value)) {
          const cloned = { ...(payload.value as Record<string, unknown>) };
          for (const field of secretFields) {
            if (typeof cloned[field] === "string") {
              cloned[field] = `ENC[${rot13(cloned[field] as string)}]`;
            }
          }
          return { ...payload, value: cloned as any };
        }
        return payload;
      });

      context.on("afterRead", (payload) => {
        if (payload.value && typeof payload.value === "object" && !Array.isArray(payload.value)) {
          const cloned = { ...(payload.value as Record<string, unknown>) };
          for (const field of secretFields) {
            const val = cloned[field];
            if (typeof val === "string" && val.startsWith("ENC[") && val.endsWith("]")) {
              const inner = val.slice(4, -1);
              cloned[field] = rot13(inner); // decrypt
            }
          }
          return { ...payload, value: cloned as any };
        }
        return payload;
      });
    },
  };
}

// =========================================================================
// Run KVDB with Both Plugins Installed
// =========================================================================
const { plugin: metricsPlugin, getMetrics } = createMetricsPlugin();
const encryptionPlugin = createEncryptionPlugin(["apiKey", "creditCardNumber"]);

const db = new KVDB({
  driver: "sqlite",
  url: ":memory:",
  plugins: [metricsPlugin, encryptionPlugin],
});

interface Account {
  username: string;
  apiKey: string;
  creditCardNumber: string;
}

const accounts = db.table<Account>("accounts");

console.log("▶ Saving account with sensitive credentials...");
await accounts.set("acc_42", {
  username: "crypto_trader",
  apiKey: "secret_api_key_xyz987",
  creditCardNumber: "4111-2222-3333-4444",
});

// 1. What does the raw underlying database physically store?
console.log("\n▶ Checking raw underlying storage (proof of encryption):");
const rawSqlite = (await db.raw()) as import("better-sqlite3").Database;
const rawRow = rawSqlite.prepare("SELECT value FROM kvdb_kv WHERE key = ?").get("accounts:acc_42") as { value: string };
console.log("Raw Stored JSON in Database:");
console.log(rawRow.value);

// 2. What does application code receive via table.get()?
console.log("\n▶ Checking decrypted value returned to application code:");
const account = await accounts.get("acc_42");
console.log("Decrypted payload visible to application:", account);

// 3. Inspect telemetry metrics gathered by the metrics plugin
console.log("\n▶ Telemetry metrics collected by plugin:");
const metrics = getMetrics();
console.log(` - Writes: ${metrics.writes}`);
console.log(` - Reads:  ${metrics.reads}`);
console.log(` - Avg Write Latency: ${(metrics.totalWriteLatencyMs / metrics.writes).toFixed(3)} ms`);
console.log(` - Avg Read Latency:  ${(metrics.totalReadLatencyMs / metrics.reads).toFixed(3)} ms`);

await db.close();
console.log("\n✓ Practical Plugins (Metrics & Encryption) example finished successfully!");
