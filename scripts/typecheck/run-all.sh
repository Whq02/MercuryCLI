#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: tsconfig.json
# ============================================================================
#  scripts/typecheck/run-all.sh — the STATIC TYPE-VERIFICATION gate.
#
#  Joins the one green-gate for free: run-all-suites.sh globs scripts/*/run-all.sh,
#  so this file auto-enrols. There is no typecheck in `bun run build.ts` (bun
#  bundles, it does not type-check), so THIS is the type floor.
#
#  Semantics — a fingerprint RATCHET, not a hard "zero everywhere" (the tree
#  carries a known strict-mode backlog that shrinks as slices are cleaned):
#
#    • BASELINE  (baseline.txt) — the committed set of KNOWN errors, one line
#      "<count>\t<fingerprint>", where a fingerprint is the tsc diagnostic with
#      its (line,col) stripped. Line shifts don't churn it; a genuinely new
#      error does.
#    • GREEN when every current fingerprint's count <= its baseline count
#      (you may FIX freely; the backlog only shrinks).
#    • RED on any NEW break: a fingerprint absent from the baseline, or one whose
#      count rose above baseline. This is the "go red on any new type/contract
#      break" contract.
#    • HARD-ZERO (hard-zero.txt) — a list of protected-clean paths that must carry
#      ZERO errors with NO baseline tolerance. The crown-jewels allowlist lives
#      here; as a file is driven to zero it graduates into this list.
#
#  Regenerate the baseline after a legitimate reduction: scripts/typecheck/regen-baseline.sh
#  Exit 0 ⇒ green; exit 1 ⇒ a new break (or a hard-zero regression).
# ============================================================================
#  WARM MODE: `--warm` (or MERCURY_TYPECHECK_WARM=1)
#  runs the SAME ratchet over an incremental tsc with a persistent
#  .claude/typecheck/typecheck.tsbuildinfo — the iteration rung of the
#  verification ladder (verify:fast calls this). The diagnostics-REPLAY
#  contract (unchanged files' known errors re-report from the buildinfo, so
#  the fingerprint ratchet sees the FULL current set) is pinned by
#  scripts/typecheck/prove-warm-replay.sh against this exact tsc. The clean
#  no-flag run stays byte-identical — it remains the closure floor.
#  MERCURY_TYPECHECK_{CFG,BASELINE,HARDZERO,BUILDINFO} are hermetic prover
#  seams; the real gate never sets them.
# ============================================================================
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
# A MISSING baseline (deleted, bad merge) is an error state — fail LOUD. An EMPTY
# baseline (the backlog-0 victory state) is legitimate and passes `-f`. Without
# this guard the awk below opens $BASE as a missing file arg → aborts with empty
# stdout → regress='' → the floor prints green on ANY new error (the same
# silent-green class the empty-baseline fix closed, via a different precondition).
[ -f "$BASE" ] || { echo "❌ typecheck — $BASE missing (regen: scripts/typecheck/regen-baseline.sh)"; exit 1; }

raw=$(mktemp); cur=$(mktemp); trap 'rm -f "$raw" "$cur"' EXIT
if [ "$WARM" -eq 1 ]; then
  mkdir -p "$(dirname "$BUILDINFO")"
  "$TSC" --noEmit -p "$CFG" --incremental --tsBuildInfoFile "$BUILDINFO" > "$raw" 2>&1
else
  "$TSC" --noEmit -p "$CFG" > "$raw" 2>&1
fi
rc=$?   # 0 clean · 2 diagnostics present (tsc 6.0.3 reports
# DiagnosticsPresent_OutputsGenerated in BOTH modes — measured cold AND warm
# on with a one-file probe; the earlier cold=1 assumption was tsc 5
# behaviour and made every real cold diagnostic read as "aborted mid-run").
# The ratchet below is the verdict for both 0 and 2.
MAXOK=2
# Anything else (128+signal = killed/OOM'd, e.g. under pooled-gate memory
# pressure) means the diagnostic list is TRUNCATED or empty — reading it as
# "zero fingerprints ⇒ green" is the silent-green class. Fail LOUD instead.
if [ "$rc" -gt "$MAXOK" ]; then
  echo "❌ typecheck — tsc aborted mid-run (exit $rc): output is untrustworthy, not clean"
  tail -20 "$raw" | sed 's/^/    /'
  exit 1
fi

# A config-level abort (e.g. a deprecated option that stops the whole run) yields
# a tiny output with no positioned diagnostics — fail loudly, don't read it as "clean".
if ! grep -qE 'error TS[0-9]+:' "$raw" && grep -qE 'error TS(5[0-9]{3}|6[0-9]{3})' "$raw"; then
  echo "❌ typecheck — tsc aborted on a config error (not a clean tree):"; sed 's/^/    /' "$raw"; exit 1
fi

# fingerprint = diagnostic line normalized to be invariant under run-to-run churn
# (see scripts/typecheck/fingerprint.sed — the single source of truth).
norm() { grep -E 'error TS[0-9]+:' "$1" | sed -E -f scripts/typecheck/fingerprint.sed; }
norm "$raw" | sort | uniq -c | sed -E 's/^ *([0-9]+) /\1\t/' > "$cur"

total_cur=$(norm "$raw" | wc -l | tr -d ' ')
total_base=$(awk -F'\t' '{s+=$1} END{print s+0}' "$BASE" 2>/dev/null || echo 0)

# regressions: current fingerprint count exceeds baseline count (0 if unknown).
# Discriminate the two inputs by FILENAME, NOT the `NR==FNR` idiom: when BASE is
# EMPTY (the backlog-0 victory state), NR==FNR stays true for the SECOND file's
# records too (the empty first file contributes 0 records), so every current
# error was misread as baseline and the regression block never ran — the floor
# went green on ANY new type error. FILENAME==basef is record-count-independent.
regress=$(awk -F'\t' -v basef="$BASE" '
  FILENAME==basef { base[$2]=$1; next }
  { if ($1+0 > base[$2]+0) printf "    +%d (baseline %d)  %s\n", $1, base[$2]+0, $2 }
' "$BASE" "$cur")

# hard-zero: any diagnostic in a protected-clean path
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
