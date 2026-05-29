// Minimal .env.test loader for the e2e suite (no dotenv dependency).
//
// Reads KEY=VALUE lines from the repo-root .env.test and copies any keys not
// already present in process.env. Quotes are stripped; `#` comments and blank
// lines are ignored. Missing file is not an error — the e2e suite simply skips
// when PG_DATABASE_URL ends up undefined.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function loadEnvTest(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../.env.test");

  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return; // no .env.test -> nothing to load
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
