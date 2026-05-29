// Runs every example in its own process, in order, and reports a summary.
//
// Run:  pnpm examples
//
// Each example is spawned via tsx so that a process.exit() or a failure in one
// (e.g. the PostgreSQL example with no PG_DATABASE_URL) does not abort the rest.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => /^\d+-.*\.ts$/.test(f)) // numbered examples only (skip this runner)
  .sort();

let failures = 0;
for (const file of files) {
  console.log(`\n${"=".repeat(70)}\n▶ ${file}\n${"=".repeat(70)}`);
  const result = spawnSync("npx", ["tsx", resolve(here, file)], { stdio: "inherit" });
  if (result.status !== 0) {
    failures++;
    console.error(`✗ ${file} exited with code ${result.status}`);
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log(failures === 0 ? `✓ all ${files.length} examples ran` : `✗ ${failures} example(s) failed`);
process.exit(failures === 0 ? 0 : 1);
