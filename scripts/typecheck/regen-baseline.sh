#!/usr/bin/env bash
# Regenerate scripts/typecheck/baseline.txt from the current strict typecheck.
# Run this ONLY after a legitimate reduction (you fixed errors) — it locks the
# new, smaller backlog in as the floor so future runs can't silently regress past
# it. Never run it to "make red go green" without having actually fixed something.
set -uo pipefail
cd "$(dirname "$0")/../.."
TSC="node_modules/.bin/tsc"; CFG="tsconfig.json"
[ -x "$TSC" ] || { echo "tsc missing — run: bun add -d typescript"; exit 1; }
raw=$(mktemp); trap 'rm -f "$raw"' EXIT
"$TSC" --noEmit -p "$CFG" > "$raw" 2>&1 || true
grep -E 'error TS[0-9]+:' "$raw" | sed -E -f scripts/typecheck/fingerprint.sed | sort | uniq -c \
  | sed -E 's/^ *([0-9]+) /\1\t/' > scripts/typecheck/baseline.txt
n=$(awk -F'\t' '{s+=$1} END{print s+0}' scripts/typecheck/baseline.txt)
fp=$(wc -l < scripts/typecheck/baseline.txt | tr -d ' ')
echo "baseline regenerated: ${n} known errors across ${fp} fingerprints"
