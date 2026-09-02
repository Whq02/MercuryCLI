#!/usr/bin/env bash
# ============================================================================
#  prove-warm-replay.sh — the warm-incremental typecheck mode is itself gated
# The fingerprint RATCHET is only sound if every run sees
#  the FULL current diagnostic set; tsc's incremental mode must therefore
#  REPLAY unchanged files' known errors from the buildinfo instead of
#  swallowing them (the silent-green class). Drives the REAL runner
#  (scripts/typecheck/run-all.sh) over a synthetic project via the hermetic
#  MERCURY_TYPECHECK_* seams, against the repo's exact vendored tsc:
#    A. clean + warm ×2 GREEN on an error-free project (idempotent replay)
#    B. a NEW error goes RED under warm (incremental catches new breaks)
#    C. the baselined error is tolerated warm (ratchet parity)
#    D. REPLAY LAW: with only the OTHER file changed and the baseline
#       emptied, the unchanged file's error must still fingerprint — a
#       swallowed replay would print GREEN here.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
runner="$here/run-all.sh"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/warm-replay.XXXXXX")
trap 'rm -rf "$work"' EXIT

printf 'export const a: number = 1\n' >"$work/a.ts"
printf 'export const b = 1\n' >"$work/b.ts"
printf '{"compilerOptions":{"strict":true,"noEmit":true},"files":["%s/a.ts","%s/b.ts"]}' "$work" "$work" >"$work/tsconfig.json"
: >"$work/baseline.txt"
: >"$work/hard-zero.txt"

run_tc() { # $1 = '' | '--warm' → echoes rc; output to $work/last.out
  (
    cd "$repo" \
      && MERCURY_TYPECHECK_CFG="$work/tsconfig.json" \
        MERCURY_TYPECHECK_BASELINE="$work/baseline.txt" \
        MERCURY_TYPECHECK_HARDZERO="$work/hard-zero.txt" \
        MERCURY_TYPECHECK_BUILDINFO="$work/bi.tsbuildinfo" \
        bash "$runner" ${1:-} >"$work/last.out" 2>&1
  )
  echo $?
}

# --- A: error-free — clean green, warm green twice, buildinfo persists --------
rcA1=$(run_tc '')
rcA2=$(run_tc '--warm')
rcA3=$(run_tc '--warm')
if [ "$rcA1" = "0" ] && [ "$rcA2" = "0" ] && [ "$rcA3" = "0" ] && [ -f "$work/bi.tsbuildinfo" ]; then
  echo "  ✓ A: clean GREEN · warm GREEN ×2 · buildinfo persisted"
else
  echo "  ✗ A broken (clean=$rcA1 warm1=$rcA2 warm2=$rcA3):"; sed 's/^/      /' "$work/last.out"; fail=1
fi

# --- B: a NEW error goes RED under warm ----------------------------------------
printf 'export const a: number = "wrong"\n' >"$work/a.ts"
rcB=$(run_tc '--warm')
if [ "$rcB" != "0" ] && grep -q 'TS2322' "$work/last.out"; then
  echo "  ✓ B: new break caught by the WARM ratchet (rc=$rcB)"
else
  echo "  ✗ B broken (rc=$rcB):"; sed 's/^/      /' "$work/last.out"; fail=1
fi

# --- C: baselined error tolerated warm (ratchet parity) ------------------------
# Derive the baseline from RAW tsc output (the runner's own norm() shape) —
# the runner's decorated regress lines are not fingerprints.
(cd "$repo" && node_modules/.bin/tsc --noEmit -p "$work/tsconfig.json" >"$work/raw.out" 2>&1) || true
fp=$(grep -E 'error TS[0-9]+:' "$work/raw.out" | sed -E -f "$here/fingerprint.sed" | sort | uniq -c | sed -E 's/^ *([0-9]+) /\1\t/')
printf '%s\n' "$fp" >"$work/baseline.txt"
rcC=$(run_tc '--warm')
if [ "$rcC" = "0" ]; then
  echo "  ✓ C: baselined error tolerated under warm (GREEN)"
else
  echo "  ✗ C broken (rc=$rcC):"; sed 's/^/      /' "$work/last.out"; fail=1
fi

# --- D: REPLAY LAW — only b.ts changes, baseline emptied ⇒ a.ts's error must
# still fingerprint from the buildinfo. GREEN here = the silent-green class.
printf 'export const b = 2\n' >"$work/b.ts"
: >"$work/baseline.txt"
rcD=$(run_tc '--warm')
if [ "$rcD" != "0" ] && grep -q 'TS2322' "$work/last.out"; then
  echo "  ✓ D: REPLAY LAW holds — the unchanged file's error re-reported from the buildinfo"
else
  echo "  ✗ D REPLAY LAW VIOLATED (rc=$rcD) — warm mode is NOT ratchet-safe on this tsc:"
  sed 's/^/      /' "$work/last.out"; fail=1
fi

exit "$fail"
