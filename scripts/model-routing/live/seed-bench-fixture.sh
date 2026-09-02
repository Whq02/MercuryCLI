#!/usr/bin/env bash
# ============================================================================
#  seed-bench-fixture.sh — recreate the frozen-mission fixture at
#  /tmp/apex-bench-fixture DETERMINISTICALLY (fixed author/committer + dates
#  ⇒ one stable SHA on every machine).
#  This seeder is the durable reproduction path benchmark.sh self-heals with.
# ============================================================================
set -euo pipefail
FIXTURE="/tmp/apex-bench-fixture"
rm -rf "$FIXTURE"
mkdir -p "$FIXTURE/src" "$FIXTURE/test"

cat > "$FIXTURE/package.json" <<'EOF'
{
  "name": "apex-bench-fixture",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF

cat > "$FIXTURE/src/stats.js" <<'EOF'
// Small numeric-stats module. Used by the report generator downstream.
export function mean(values) {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i <= values.length; i++) {
    sum += values[i]
  }
  return sum / values.length
}

export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort()
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

export function variance(values) {
  if (values.length < 2) return 0
  const m = mean(values)
  let sum = 0
  for (const v of values) {
    sum += (v - m) * (v - m)
  }
  return sum / (values.length - 1)
}
EOF

cat > "$FIXTURE/test/stats.test.mjs" <<'EOF'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mean, median, variance } from '../src/stats.js'

test('mean of simple values', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5)
})

test('mean of empty list is 0', () => {
  assert.equal(mean([]), 0)
})

test('median sorts numerically (two-digit values)', () => {
  assert.equal(median([10, 2, 33, 4, 5]), 5)
})

test('median of even-length list averages the middle pair', () => {
  assert.equal(median([7, 1, 3, 9]), 5)
})

test('sample variance', () => {
  assert.equal(variance([2, 4, 4, 4, 5, 5, 7, 9]), 4.571428571428571)
})
EOF

cd "$FIXTURE"
git init -q
git add -A
GIT_AUTHOR_NAME="apex-fixture" GIT_AUTHOR_EMAIL="fixture@mercury.local" \
GIT_COMMITTER_NAME="apex-fixture" GIT_COMMITTER_EMAIL="fixture@mercury.local" \
GIT_AUTHOR_DATE="2026-07-21T00:00:00Z" GIT_COMMITTER_DATE="2026-07-21T00:00:00Z" \
git commit -q -m "fixture: stats module with seeded defects"
git rev-parse HEAD
