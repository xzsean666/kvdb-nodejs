import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2023",
  shims: true,
  external: ["better-sqlite3", "mongodb", "pg", "mysql2", "ioredis"],
});
