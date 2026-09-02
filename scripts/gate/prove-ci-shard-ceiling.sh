#!/usr/bin/env bash
# ============================================================================
#  prove-ci-shard-ceiling.sh — the CI shard's HANG LAW is itself gated.
#
#  Exercises scripts/gate/ci-shard.sh against SYNTHETIC estates via its
#  hermetic seams (MERCURY_CI_SHARD_SUITES_DIR/_SEED_FILE/_CEILING_FILE/_OUT
#  — no recursion, never the real estate):
#    A1. hang law   — a wedging pty suite is tree-killed at the CEILING even
#                     under the operator's huge MERCURY_SUITE_TIMEOUT pin,
#                     lands as a NAMED red row (rc 137, retry '-'), the
#                     marker names the ceiling rule, the solo re-run is
#                     SKIPPED loudly (a timeout is not a flake).
#    A2. row-first  — a genuine pty RED's attempt-1 row is ALREADY in
#                     results.tsv while its retry runs (the retry attempt
#                     itself witnesses the row), and the retry REWRITES the
#                     row (one row, retry columns filled — never a dup).
#    A3. grant      — a suite named in the ceiling file lives past the
#                     default ceiling (the grant wins over the env default).
#    B1. cap-only   — the ceiling CAPS budgets, never raises them: a suite
#                     whose rule-budget is below its generous ceiling still
#                     dies at the rule; a pure-class hang draws the loud
#                     HANG line too (no retry lane involved).
#  Bash-3.2 portable (macOS /bin/bash). Fast: ceilings of 1–8 s.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-shard-ceiling-proof.XXXXXX")
trap 'rm -rf "$work"' EXIT

mk_suite() { # $1=dom  $2=class-header-line (may be empty)  $3=body
  mkdir -p "$work/suites/$1"
  {
    echo '#!/usr/bin/env bash'
    [ -n "$2" ] && echo "$2"
    echo "$3"
  } >"$work/suites/$1/run-all.sh"
}

# One inherited scratch home: the shard honours an explicit pin, so the
# seeder runs on THIS dir, never a real one.
export MERCURY_CONFIG_DIR="$work/config-home"
mkdir -p "$MERCURY_CONFIG_DIR"

shard() { # $1=out-subdir, then env pins; runs the WHOLE synthetic estate as shard 0/1
  local out=$1; shift
  (
    cd "$repo" && env -u MERCURY_SUITE_TIMEOUT -u MERCURY_SUITE_TIMEOUT_FLOOR -u MERCURY_SUITE_CEILING \
      MERCURY_CI_SHARD_SUITES_DIR="$work/suites" \
      MERCURY_CI_SHARD_SEED_FILE="$work/seed.tsv" \
      MERCURY_CI_SHARD_CEILING_FILE="$work/ceilings.tsv" \
      MERCURY_CI_SHARD_OUT="$work/$out" \
      "$@" bash scripts/gate/ci-shard.sh 0 1
  ) 2>&1
}

# --- estate A: hang law + row-first retry + the grant -------------------------
# wedge   (pty, unlisted)  sleeps 600 → killed at the 2 s DEFAULT ceiling
# granted (pty, listed 8)  sleeps 3   → lives past the 2 s default (the grant)
# redo    (pty)            exits 5 fast; its RETRY witnesses attempt-1's row
# verdant (pure)           exits 0    → the green control row
mk_suite wedge '# gate-class: pty' 'sleep 600'
mk_suite granted '# gate-class: pty' 'sleep 3; exit 0'
mk_suite redo '# gate-class: pty' "if [ -f '$work/redo.once' ]; then grep -c '^redo	' '$work/outA/results.tsv' >'$work/redo.witness' 2>/dev/null; else touch '$work/redo.once'; fi; echo redo-red >&2; exit 5"
# mimic: a RED suite that merely PRINTS the timeout marker text (the gate
# machinery self-test does exactly this with its synthetic estates) — it was
# never watchdog-killed, so it must classify RED-with-retry, never HANG.
mk_suite mimic '# gate-class: pty' 'echo "__SUITE_TIMEOUT after 999s (tree-killed; synthetic inner marker)__"; exit 3'
mk_suite verdant '# gate-class: pure' 'exit 0'
printf 'wedge\t100\ngranted\t50\nredo\t10\nmimic\t5\nverdant\t1\n' >"$work/seed.tsv"
printf '# synthetic grants\ngranted\t8\n' >"$work/ceilings.tsv"

outA=$(shard outA MERCURY_SUITE_TIMEOUT=3000 MERCURY_SUITE_CEILING=2); rcA=$?
tsvA="$work/outA/results.tsv"

# A1 — the wedge is a NAMED red row, killed at the ceiling, retry skipped.
if [ "$rcA" != "0" ] && grep -q '^wedge	pty	137	' "$tsvA" && grep -q '^wedge	.*	-	-$' "$tsvA"; then
  echo "  ✓ hang law: the wedge is a NAMED red row (rc 137, retry '-') under the 3000 s operator pin"
else
  echo "  ✗ hang law: wedge row wrong (shard rc=$rcA) — $(grep '^wedge' "$tsvA" 2>/dev/null || echo 'NO ROW')"; fail=1
fi
if grep -q '__SUITE_TIMEOUT after 2s (tree-killed; the 2s suite ceiling — the hang law)__' "$work/outA/wedge.out" 2>/dev/null; then
  echo "  ✓ hang marker: the kill line names the ceiling rule"
else
  echo "  ✗ hang marker: ceiling rule text missing —"; grep -a SUITE_TIMEOUT "$work/outA/wedge.out" 2>/dev/null | sed 's/^/      /'; fail=1
fi
if printf '%s' "$outA" | grep -q 'wedge.*HANG — tree-killed at .*solo re-run SKIPPED' \
   && ! printf '%s' "$outA" | grep -q 'wedge.*recorded solo re-run'; then
  echo "  ✓ retry scope: the hang drew the loud SKIP line and NO solo re-run"
else
  echo "  ✗ retry scope: hang line/skip wrong:"; printf '%s\n' "$outA" | grep wedge | sed 's/^/      /'; fail=1
fi

# A1b — marker-mimic law: a red suite whose LOG contains the marker text but
# was never watchdog-killed is a plain RED (retried per policy), never a HANG
# — the hang verdict belongs to the watchdog's own testimony, not to text.
if printf '%s' "$outA" | grep -q 'mimic.*recorded solo re-run' \
   && ! printf '%s' "$outA" | grep -q 'mimic.*HANG' \
   && grep -q '^mimic	pty	3	[0-9]*	3	[0-9]*$' "$tsvA"; then
  echo "  ✓ mimic law: printed marker text did not fake a hang (RED, retried, row rewritten rc 3/3)"
else
  echo "  ✗ mimic law: a printed marker was classified as a hang — $(grep '^mimic' "$tsvA" 2>/dev/null || echo 'NO ROW')"; printf '%s\n' "$outA" | grep mimic | sed 's/^/      /'; fail=1
fi

# A2 — the genuine red retried; its retry SAW attempt-1's row; the row was
# rewritten in place (one row, retry columns filled).
witness=$(cat "$work/redo.witness" 2>/dev/null || echo 0)
rows_redo=$(grep -c '^redo	' "$tsvA" 2>/dev/null)
if [ "$witness" -ge 1 ] && [ "$rows_redo" = "1" ] && grep -q '^redo	pty	5	[0-9]*	5	[0-9]*$' "$tsvA"; then
  echo "  ✓ row-first: the retry witnessed attempt-1's row in results.tsv; the final row is ONE rewritten row (rc 5 / retry 5)"
else
  echo "  ✗ row-first: witness=$witness rows=$rows_redo — $(grep '^redo' "$tsvA" 2>/dev/null)"; fail=1
fi

# A3 — the grant: listed at 8 s, slept 3 s under a 2 s default ceiling, lived.
if grep -q '^granted	pty	0	' "$tsvA"; then
  echo "  ✓ grant: the ceiling-file row (8 s) carried 'granted' past the 2 s default ceiling"
else
  echo "  ✗ grant: granted did not survive — $(grep '^granted' "$tsvA" 2>/dev/null || echo 'NO ROW')"; fail=1
fi
if grep -q '^verdant	pure	0	' "$tsvA" && [ "$(wc -l <"$tsvA" | tr -d ' ')" = "5" ]; then
  echo "  ✓ estate: 5 rows exactly, the green control among them"
else
  echo "  ✗ estate rows wrong:"; sed 's/^/      /' "$tsvA" 2>/dev/null; fail=1
fi

# --- estate B: the ceiling only CAPS — never raises — and pure hangs are loud -
rm -rf "$work/suites"
mk_suite capped '# gate-class: pure' 'sleep 30'
printf 'capped\t1\n' >"$work/seed.tsv"
printf 'capped\t100\n' >"$work/ceilings.tsv"
outB=$(shard outB MERCURY_SUITE_TIMEOUT_FLOOR=1 MERCURY_SUITE_CEILING=50); rcB=$?
tsvB="$work/outB/results.tsv"
secsB=$(sed -n 's/^capped	pure	137	\([0-9]*\)	.*/\1/p' "$tsvB" 2>/dev/null)
if [ "$rcB" != "0" ] && [ -n "$secsB" ] && [ "$secsB" -le 6 ]; then
  echo "  ✓ cap-only: rule budget 2 s bound despite a 100 s grant (killed at ${secsB}s, rc 137)"
else
  echo "  ✗ cap-only: $(grep '^capped' "$tsvB" 2>/dev/null || echo 'NO ROW') (shard rc=$rcB)"; fail=1
fi
if printf '%s' "$outB" | grep -q 'capped.*HANG — tree-killed'; then
  echo "  ✓ pure hang: the loud HANG line prints for a non-pty class too"
else
  echo "  ✗ pure hang line missing:"; printf '%s\n' "$outB" | grep capped | sed 's/^/      /'; fail=1
fi

exit "$fail"
