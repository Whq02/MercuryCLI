#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
TSC="node_modules/.bin/tsc"; CFG="tsconfig.json"
[ -x "$TSC" ] || { echo "tsc missing — run: bun add -d typescript"; exit 1; }
raw=$(mktemp); trap 'rm -f "$raw"' EXIT
"$TSC" --noEmit -p "$CFG" > "$raw" 2>&1 || true
grep -E 'error TS[0-9]+:' "$raw" | sed -E -f scripts/typecheck/fingerprint.sed | sort | uniq -c \
  | sed -E 's/^ *([0-9]+) /\1\t/' > scripts/typecheck/baseline.txt
n=$(awk -F'\t' '{s+=$1} END{print s+0}' scripts/typecheck/baseline.txt)
fp=$(wc -l < scripts/typecheck/baseline.txt | tr -d ' ')
echo "baseline regenerated: ${n} known errors across ${fp} fingerprints"
