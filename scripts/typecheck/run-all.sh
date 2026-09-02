#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: tsconfig.json
set -uo pipefail
cd "$(dirname "$0")/../.."

TSC="node_modules/.bin/tsc"
CFG="${MERCURY_TYPECHECK_CFG:-tsconfig.json}"
BASE="${MERCURY_TYPECHECK_BASELINE:-scripts/typecheck/baseline.txt}"
HARDZERO="${MERCURY_TYPECHECK_HARDZERO:-scripts/typecheck/hard-zero.txt}"
. "$(dirname "$0")/../lib/project-home.sh"
BUILDINFO="${MERCURY_TYPECHECK_BUILDINFO:-$(project_store_dir "$PWD" typecheck)/typecheck.tsbuildinfo}"

WARM=0
[ "${1:-}" = "--warm" ] && WARM=1
[ "${MERCURY_TYPECHECK_WARM:-0}" = "1" ] && WARM=1

[ -x "$TSC" ] || { echo "❌ typecheck — $TSC missing (run: bun add -d typescript)"; exit 1; }
[ -f "$CFG" ]  || { echo "❌ typecheck — $CFG missing"; exit 1; }
[ -f "$BASE" ] || { echo "❌ typecheck — $BASE missing (regen: scripts/typecheck/regen-baseline.sh)"; exit 1; }

raw=$(mktemp); cur=$(mktemp); trap 'rm -f "$raw" "$cur"' EXIT
if [ "$WARM" -eq 1 ]; then
  mkdir -p "$(dirname "$BUILDINFO")"
  "$TSC" --noEmit -p "$CFG" --incremental --tsBuildInfoFile "$BUILDINFO" > "$raw" 2>&1
else
  "$TSC" --noEmit -p "$CFG" > "$raw" 2>&1
fi
rc=$?   # 0 clean · 2 diagnostics present (tsc 6.0.3 reports
MAXOK=2
if [ "$rc" -gt "$MAXOK" ]; then
  echo "❌ typecheck — tsc aborted mid-run (exit $rc): output is untrustworthy, not clean"
  tail -20 "$raw" | sed 's/^/    /'
  exit 1
fi

if ! grep -qE 'error TS[0-9]+:' "$raw" && grep -qE 'error TS(5[0-9]{3}|6[0-9]{3})' "$raw"; then
  echo "❌ typecheck — tsc aborted on a config error (not a clean tree):"; sed 's/^/    /' "$raw"; exit 1
fi

norm() { grep -E 'error TS[0-9]+:' "$1" | sed -E -f scripts/typecheck/fingerprint.sed; }
norm "$raw" | sort | uniq -c | sed -E 's/^ *([0-9]+) /\1\t/' > "$cur"

total_cur=$(norm "$raw" | wc -l | tr -d ' ')
total_base=$(awk -F'\t' '{s+=$1} END{print s+0}' "$BASE" 2>/dev/null || echo 0)

regress=$(awk -F'\t' -v basef="$BASE" '
  FILENAME==basef { base[$2]=$1; next }
  { if ($1+0 > base[$2]+0) printf "    +%d (baseline %d)  %s\n", $1, base[$2]+0, $2 }
' "$BASE" "$cur")

hzviol=""
if [ -s "$HARDZERO" ]; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in \#*) continue;; esac
    pe=$(printf '%s' "$p" | sed 's/[.[]/\\&/g')
    hits=$(grep -E "^${pe}\(" "$raw" || true)
    [ -n "$hits" ] && hzviol+="$hits"$'\n'
  done < "$HARDZERO"
fi

if [ -z "$regress" ] && [ -z "$hzviol" ]; then
  echo "✅ typecheck$([ "$WARM" -eq 1 ] && echo ' (warm incremental)') — no new type/contract breaks (backlog: ${total_cur} known / baseline ${total_base})"
  [ "$total_cur" -lt "$total_base" ] && echo "   ↓ backlog shrank by $((total_base - total_cur)) — run scripts/typecheck/regen-baseline.sh to lock it in"
  exit 0
fi

echo "❌ typecheck — NEW type/contract break(s):"
[ -n "$regress" ] && { echo "  ── new vs baseline ──"; printf '%s\n' "$regress"; }
[ -n "$hzviol" ]  && { echo "  ── HARD-ZERO path regressed (must stay clean) ──"; printf '%s' "$hzviol" | sed '/^$/d;s/^/    /'; }
exit 1
