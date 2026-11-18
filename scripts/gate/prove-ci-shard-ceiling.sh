#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-shard-ceiling-proof.XXXXXX")
trap 'rm -rf "$work"' EXIT

mk_suite() {
  mkdir -p "$work/suites/$1"
  {
    echo '#!/usr/bin/env bash'
    [ -n "$2" ] && echo "$2"
    echo "$3"
  } >"$work/suites/$1/run-all.sh"
}

export MERCURY_CONFIG_DIR="$work/config-home"
mkdir -p "$MERCURY_CONFIG_DIR"

shard() {
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

mk_suite wedge '# gate-class: pty' 'sleep 600'
mk_suite granted '# gate-class: pty' 'sleep 3; exit 0'
mk_suite redo '# gate-class: pty' "if [ -f '$work/redo.once' ]; then grep -c '^redo	' '$work/outA/results.tsv' >'$work/redo.witness' 2>/dev/null; else touch '$work/redo.once'; fi; echo redo-red >&2; exit 5"
mk_suite mimic '# gate-class: pty' 'echo "__SUITE_TIMEOUT after 999s (tree-killed; synthetic inner marker)__"; exit 3'
mk_suite verdant '# gate-class: pure' 'exit 0'
printf 'wedge\t100\ngranted\t50\nredo\t10\nmimic\t5\nverdant\t1\n' >"$work/seed.tsv"
printf '# synthetic grants\ngranted\t8\n' >"$work/ceilings.tsv"

outA=$(shard outA MERCURY_SUITE_TIMEOUT=3000 MERCURY_SUITE_CEILING=2); rcA=$?
tsvA="$work/outA/results.tsv"

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

if printf '%s' "$outA" | grep -q 'mimic.*recorded solo re-run' \
   && ! printf '%s' "$outA" | grep -q 'mimic.*HANG' \
   && grep -q '^mimic	pty	3	[0-9]*	3	[0-9]*$' "$tsvA"; then
  echo "  ✓ mimic law: printed marker text did not fake a hang (RED, retried, row rewritten rc 3/3)"
else
  echo "  ✗ mimic law: a printed marker was classified as a hang — $(grep '^mimic' "$tsvA" 2>/dev/null || echo 'NO ROW')"; printf '%s\n' "$outA" | grep mimic | sed 's/^/      /'; fail=1
fi

witness=$(cat "$work/redo.witness" 2>/dev/null || echo 0)
rows_redo=$(grep -c '^redo	' "$tsvA" 2>/dev/null)
if [ "$witness" -ge 1 ] && [ "$rows_redo" = "1" ] && grep -q '^redo	pty	5	[0-9]*	5	[0-9]*$' "$tsvA"; then
  echo "  ✓ row-first: the retry witnessed attempt-1's row in results.tsv; the final row is ONE rewritten row (rc 5 / retry 5)"
else
  echo "  ✗ row-first: witness=$witness rows=$rows_redo — $(grep '^redo' "$tsvA" 2>/dev/null)"; fail=1
fi

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

rm -rf "$work/suites" "$work/planC"
mk_suite r1 '# gate-class: pure' 'exit 0'
mk_suite r2 '# gate-class: cpu' 'echo cpu-red >&2; exit 3'
mk_suite x1 '# gate-class: exclusive' 'exit 0'
mk_suite d1 '# gate-class: pty' 'exit 0'
mk_suite d2 '# gate-class: pty' "if [ -f '$work/d2.once' ]; then exit 0; else touch '$work/d2.once'; echo '[ptydrive] UNFIRED-SENDS: 1 of 3 sends never became due — first stuck: 4500:hello' >&2; exit 5; fi"
mk_suite u1 '' 'exit 0'
printf 'r1\t1\nr2\t2\nx1\t1\nd1\t3\nd2\t4\nu1\t1\n' >"$work/seed.tsv"
: >"$work/ceilings.tsv"
plan_of() {
  (
    cd "$repo" && MERCURY_CI_SHARD_SUITES_DIR="$work/suites" MERCURY_CI_SHARD_SEED_FILE="$work/seed.tsv" \
      MERCURY_CI_SHARD_CEILING_FILE="$work/ceilings.tsv" MERCURY_CI_SHARD_OUT="$work/planC" \
      bash scripts/gate/ci-shard.sh 0 1 --class "$1" --plan-only 2>"$work/plan-$1.err"
  )
}
shard_class() {
  local out=$1 cls=$2; shift 2
  (
    cd "$repo" && env -u MERCURY_SUITE_TIMEOUT -u MERCURY_SUITE_TIMEOUT_FLOOR -u MERCURY_SUITE_CEILING \
      MERCURY_CI_SHARD_SUITES_DIR="$work/suites" \
      MERCURY_CI_SHARD_SEED_FILE="$work/seed.tsv" \
      MERCURY_CI_SHARD_CEILING_FILE="$work/ceilings.tsv" \
      MERCURY_CI_SHARD_OUT="$work/$out" \
      "$@" bash scripts/gate/ci-shard.sh 0 1 --class "$cls"
  ) 2>&1
}
rel=$(plan_of release | sort | paste -sd' ' -)
drv=$(plan_of drives | sort | paste -sd' ' -)
all=$(plan_of all | sort | paste -sd' ' -)
if [ "$rel" = "r1 r2 x1" ] && [ "$drv" = "d1 d2" ]; then
  echo "  ✓ split plans: --class release = {r1 r2 x1} (no pty) · --class drives = {d1 d2} (only pty)"
else
  echo "  ✗ split plans: release='$rel' drives='$drv'"; fail=1
fi
if [ "$(printf '%s %s\n' "$rel" "$drv" | tr ' ' '\n' | sort | paste -sd' ' -)" = "d1 d2 r1 r2 x1" ]; then
  echo "  ✓ union law: release ∪ drives = every declared suite, each exactly once"
else
  echo "  ✗ union law: '$rel' + '$drv'"; fail=1
fi
if [ "$all" = "d1 d2 r1 r2 u1 x1" ]; then
  echo "  ✓ whole plan: --class all keeps every suite, the undeclared one included"
else
  echo "  ✗ whole plan: '$all'"; fail=1
fi
if grep -q 'UNCLASSED suite u1' "$work/plan-release.err" && grep -q 'UNCLASSED suite u1' "$work/plan-drives.err" && [ ! -d "$work/planC" ]; then
  echo "  ✓ unclassed: u1 falls in neither split plan and is NAMED on stderr by both; --plan-only wrote no output dir"
else
  echo "  ✗ unclassed/plan-only: $(cat "$work/plan-release.err" 2>/dev/null | head -2) dir=$([ -d "$work/planC" ] && echo present || echo absent)"; fail=1
fi
( cd "$repo" && bash scripts/gate/ci-shard.sh 0 1 --class bogus --plan-only >/dev/null 2>&1 ); rcBogus=$?
if [ "$rcBogus" = "2" ]; then
  echo "  ✓ class law: an unknown --class is refused (exit 2)"
else
  echo "  ✗ class law: --class bogus exited $rcBogus"; fail=1
fi
outC1=$(shard_class outC1 release MERCURY_SUITE_CEILING=20); rcC1=$?
tsvC1="$work/outC1/results.tsv"
if [ "$rcC1" != "0" ] && [ "$(cut -f1 "$tsvC1" | sort | paste -sd' ' -)" = "r1 r2 x1" ] \
   && grep -q '^r2	cpu	3	[0-9]*	3	[0-9]*$' "$tsvC1" && printf '%s' "$outC1" | grep -q 'recorded solo re-run' \
   && printf '%s' "$outC1" | grep -q 're-run still RED — genuine' \
   && printf '%s' "$outC1" | grep -q 'shard 0/1 (release): 3 suites'; then
  echo "  ✓ release run: rows r1 r2 x1 only · the cpu red re-ran solo once and stayed red (rc 3 / retry 3) · the banner names the class · shard red"
else
  echo "  ✗ release run: rc=$rcC1 rows='$(cut -f1 "$tsvC1" 2>/dev/null | paste -sd' ' -)'"; printf '%s\n' "$outC1" | sed 's/^/      /' | head -12; fail=1
fi
outC2=$(shard_class outC2 drives MERCURY_SUITE_CEILING=20); rcC2=$?
tsvC2="$work/outC2/results.tsv"
if [ "$rcC2" = "0" ] && [ "$(cut -f1 "$tsvC2" | sort | paste -sd' ' -)" = "d1 d2" ] \
   && grep -q '^d2	pty	5	[0-9]*	0	[0-9]*$' "$tsvC2" && printf '%s' "$outC2" | grep -q 'd2.*re-run GREEN — runner flake RECORDED'; then
  echo "  ✓ drives run: rows d1 d2 only · the pty red re-ran solo once and recovered (rc 5 → 0, RECORDED) · shard green"
else
  echo "  ✗ drives run: rc=$rcC2 rows='$(cut -f1 "$tsvC2" 2>/dev/null | paste -sd' ' -)'"; printf '%s\n' "$outC2" | sed 's/^/      /' | head -12; fail=1
fi
if grep -q '^d2	attempt 1: \[ptydrive\] UNFIRED-SENDS: 1 of 3 sends never became due — first stuck: 4500:hello' "$work/outC2/notes.tsv" 2>/dev/null \
   && ! grep -q '^d1	' "$work/outC2/notes.tsv"; then
  echo "  ✓ notes: d2's first stuck send is recorded (from attempt 1, the re-run had none); the clean suite has no note"
else
  echo "  ✗ notes.tsv wrong:"; sed 's/^/      /' "$work/outC2/notes.tsv" 2>/dev/null; fail=1
fi

rm -rf "$work/suites" "$work/h1.once" "$work/h1.homes" "$work/h1.seeded"
mk_suite first '# gate-class: pure' 'exit 0'
mk_suite h1 '# gate-class: pure' "echo \"\$MERCURY_CONFIG_DIR\" >>'$work/h1.homes'; [ -f \"\$MERCURY_CONFIG_DIR/.mercury.json\" ] && echo seeded >>'$work/h1.seeded'; if [ -e \"\$MERCURY_CONFIG_DIR/h1.marker\" ]; then echo '── scripts/h1/prove-stands-on-an-unused-home.sh  0s rc=1'; exit 1; fi; touch \"\$MERCURY_CONFIG_DIR/h1.marker\"; if [ ! -f '$work/h1.once' ]; then touch '$work/h1.once'; echo '── scripts/h1/prove-loses-the-clock.sh  0s rc=1'; exit 5; fi; exit 0"
printf 'first\t5\nh1\t1\n' >"$work/seed.tsv"
: >"$work/ceilings.tsv"
outD=$(shard_class outD release MERCURY_SUITE_CEILING=20); rcD=$?
tsvD="$work/outD/results.tsv"
homeD1=$(sed -n 1p "$work/h1.homes" 2>/dev/null)
homeD2=$(sed -n 2p "$work/h1.homes" 2>/dev/null)
besideD="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
besideD="${besideD%/}"
if [ "$rcD" = "0" ] && grep -q '^h1	pure	5	[0-9]*	0	[0-9]*$' "$tsvD" && printf '%s' "$outD" | grep -q 'h1.*re-run GREEN — runner flake RECORDED' \
   && [ "$homeD1" = "$MERCURY_CONFIG_DIR" ] && [ -e "$MERCURY_CONFIG_DIR/h1.marker" ] && [ "$(grep -c seeded "$work/h1.seeded" 2>/dev/null)" = "2" ]; then
  echo "  ✓ second home: a suite red once found no marker of its first run the second time (rc 5 → 0, RECORDED), and both homes were seeded"
else
  echo "  ✗ second home: the second run stood on the first run's home — rc=$rcD row='$(grep '^h1' "$tsvD" 2>/dev/null)' homes='$(paste -sd' ' "$work/h1.homes" 2>/dev/null)' — scripts/gate/ci-shard.sh gives the re-run a home of its own"; printf '%s\n' "$outD" | grep h1 | sed 's/^/      /'; fail=1
fi
case "$homeD2" in
  ("$besideD"/mercury-proof-home.??????)
    if [ ! -e "$homeD2" ]; then
      echo "  ✓ second home: made beside the shard's by the same form (mercury-proof-home.XXXXXX under the shard's temp root) and removed after the run"
    else
      echo "  ✗ second home: $homeD2 still stands after the shard — scripts/gate/ci-shard.sh removes the re-run's home when the re-run ends"; fail=1
    fi ;;
  (*) echo "  ✗ second home: '$homeD2' is not a mercury-proof-home.XXXXXX under $besideD — scripts/gate/ci-shard.sh makes the re-run's home as it makes the shard's"; fail=1 ;;
esac
mkdir -p "$work/verdictD/results"
cp -R "$work/suites" "$work/verdictD/scripts"
cp -R "$work/outD" "$work/verdictD/results/s0"
( cd "$work/verdictD" && unset GITHUB_STEP_SUMMARY && /usr/bin/env python3 "$here/ci-verdict.py" results --scope release ) >"$work/verdictD/out.txt" 2>&1; rcV=$?
if [ "$rcV" = "0" ] && /usr/bin/env python3 -c "import json,sys; v=json.load(open('$work/verdictD/ci-verdict.json')); f=v['flakes']; sys.exit(0 if v['ok'] and len(f)==1 and f[0]['suite']=='h1' and f[0]['pooledRc']==5 and f[0]['soloRc']==0 and f[0]['pooledMembers']==['scripts/h1/prove-loses-the-clock.sh'] and f[0]['soloMembers']==[] and f[0]['homeSuitesBefore']==1 else 1)"; then
  echo "  ✓ verdict row: the flake names the member red in the first attempt and the one suite that had used the shard's home before it"
else
  echo "  ✗ verdict row: rc=$rcV flakes=$(/usr/bin/env python3 -c "import json; print(json.load(open('$work/verdictD/ci-verdict.json')).get('flakes'))" 2>&1 | head -3) — scripts/gate/ci-verdict.py reads the members from <suite>.out beside results.tsv"; fail=1
fi
exit "$fail"
