#!/usr/bin/env bash
set -e

# Ports and URLs
PG_PORT="${PG_PORT:-5433}"
PG_URL="${KVDB_TEST_PG_URL:-postgres://postgres:kvdb_test@127.0.0.1:${PG_PORT}/postgres}"

MONGO_PORT="${MONGO_PORT:-27018}"
MONGO_URL="${KVDB_TEST_MONGO_URL:-mongodb://127.0.0.1:${MONGO_PORT}/kvdb_test}"

REDIS_PORT="${REDIS_PORT:-6380}"
REDIS_URL="${KVDB_TEST_REDIS_URL:-redis://127.0.0.1:${REDIS_PORT}}"

MYSQL_PORT="${MYSQL_PORT:-3307}"
MYSQL_URL="${KVDB_TEST_MYSQL_URL:-mysql://root:kvdb_test@127.0.0.1:${MYSQL_PORT}/kvdb_test}"

echo "=== Running KVDB SDK Full Multi-Driver Compliance Suite ==="
echo "PostgreSQL: ${PG_URL}"
echo "MongoDB:    ${MONGO_URL}"
echo "Redis:      ${REDIS_URL}"
echo "MySQL:      ${MYSQL_URL}"
echo "SQLite:     :memory:"
echo "---------------------------------------------------------"

KVDB_TEST_PG_URL="${PG_URL}" \
KVDB_TEST_MONGO_URL="${MONGO_URL}" \
KVDB_TEST_REDIS_URL="${REDIS_URL}" \
KVDB_TEST_MYSQL_URL="${MYSQL_URL}" \
pnpm vitest run test/compliance

echo "---------------------------------------------------------"
echo "=== All driver compliance tests completed successfully! ==="
