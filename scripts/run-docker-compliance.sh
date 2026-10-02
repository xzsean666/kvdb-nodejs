#!/usr/bin/env bash
set -e

# Ports and URLs
PG_PORT="${PG_PORT:-5433}"
PG_URL="${KVDB_TEST_PG_URL:-postgres://postgres:kvdb_test@127.0.0.1:${PG_PORT}/postgres}"

MONGO_PORT="${MONGO_PORT:-27018}"
MONGO_URL="${KVDB_TEST_MONGO_URL:-mongodb://127.0.0.1:${MONGO_PORT}/kvdb_test}"

echo "=== Running KVDB SDK Full Multi-Driver Compliance Suite ==="
echo "PostgreSQL: ${PG_URL}"
echo "MongoDB:    ${MONGO_URL}"
echo "SQLite:     :memory:"
echo "---------------------------------------------------------"

KVDB_TEST_PG_URL="${PG_URL}" KVDB_TEST_MONGO_URL="${MONGO_URL}" pnpm vitest run test/compliance

echo "---------------------------------------------------------"
echo "=== All 93 driver compliance tests completed successfully! ==="
