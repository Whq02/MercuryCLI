#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/gate-keep-going-proof.XXXXXX")
trap 'rm -rf "$work"' EXIT

mk_suite() {
  mkdir -p "$work/suites/$1"
  printf '#!/usr/bin/env bash\n%s\n%s\n' "# gate-class: $2" "$3" >"$work/suites/$1/run-all.sh"
}
gate() {
  (
    cd "$repo" && env -u MERCURY_SUITE_TIMEOUT -u MERCURY_SUITE_TIMEOUT_FLOOR -u MERCURY_GATE_RETRY \
      -u MERCURY_GATE_BUILD_CMD -u MERCURY_GATE_NO_PREBUILD -u MERCURY_GATE_DIST_MANIFEST -u MERCURY_GATE_VERDICT_FILE \
      -u MERCURY_GATE_JOBS -u MERCURY_GATE_CORES -u MERCURY_GATE_PTY_MAX -u MERCURY_GATE_DIST_CACHE -u MERCURY_GATE_PREBUILT \
      MERCURY_GATE_SUITES_DIR="$work/suites" MERCURY_GATE_SEED_FILE="$work/seed.tsv" "$@"
  ) 2>&1
}
runner() { gate "$1" bash scripts/run-all-suites.sh "${@:2}"; }
fresh() { rm -rf "$work/ran"; mkdir -p "$work/ran"; }
has() { printf '%s\n' "$1" | grep -qE -- "$2"; }
count() { printf '%s\n' "$1" | grep -cE -- "$2"; }
last() { printf '%s\n' "$1" | tail -n "$2" | head -1; }
ok() { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; printf '%s\n' "$2" | sed 's/^/      /'; fail=1; }

mk_suite zz-red cpu ": >'$work/ran/zz-red'; echo keep-going-red >&2; exit 3"
mk_suite aa-green cpu ": >'$work/ran/aa-green'; exit 0"
printf 'zz-red\t9\naa-green\t1\n' >"$work/seed.tsv"

ASKED='^suites asked [0-9]+ · ran [0-9]+ · not launched [0-9]+'
SKIP='^  ⏭  aa-green +not launched \(fail-fast: an iteration rung stops on RED\)$'
RED_END='^❌ 1/2 RED: zz-red  ·  [0-9]+s total$'

for pin in MERCURY_GATE_JOBS=1 MERCURY_GATE_CORES=2; do
  fresh
  out=$(runner "$pin" zz-red aa-green); rc=$?
  if [ "$rc" = "1" ] && has "$out" '^  ❌ zz-red ' && has "$out" "$SKIP" && ! has "$out" '✅ aa-green' \
     && [ -e "$work/ran/zz-red" ] && [ ! -e "$work/ran/aa-green" ] && ! has "$out" "$ASKED" && has "$(last "$out" 1)" "$RED_END"; then
    ok "without the word ($pin): the named run stops at the red suite, the second is not launched and is reported so, exit 1, no count line"
  else
    bad "without the word ($pin): the named run no longer reads as it did (rc=$rc)" "$out"
  fi

  fresh
  out=$(runner "$pin" --keep-going zz-red aa-green); rc=$?
  if [ "$rc" = "1" ] && has "$out" '^  ❌ zz-red ' && has "$out" '^  ✅ aa-green ' && ! has "$out" 'not launched \(fail-fast' \
     && [ -e "$work/ran/zz-red" ] && [ -e "$work/ran/aa-green" ] && [ "$(count "$out" "$ASKED")" = "1" ] \
     && [ "$(last "$out" 2)" = "suites asked 2 · ran 2 · not launched 0" ] && has "$(last "$out" 1)" "$RED_END"; then
    ok "with --keep-going ($pin): both named suites run whatever goes red, the end counts 2 asked and 2 ran, exit still 1"
  else
    bad "with --keep-going ($pin): the named run did not launch every suite or did not count them (rc=$rc)" "$out"
  fi
done

fresh
out=$(runner MERCURY_GATE_JOBS=1 --keep-going zz-red aa-green no-such-suite); rc=$?
if [ "$rc" = "1" ] && [ "$(last "$out" 2)" = "suites asked 3 · ran 2 · not launched 1: no-such-suite (no runner)" ] && [ -e "$work/ran/aa-green" ]; then
  ok "with --keep-going: a name that has no runner is counted as asked and named as not launched"
else
  bad "with --keep-going: a name with no runner is not named at the end (rc=$rc)" "$out"
fi

out=$(runner MERCURY_GATE_JOBS=1 --keep-going no-such-suite); rc=$?
out0=$(runner MERCURY_GATE_JOBS=1 no-such-suite); rc0=$?
if [ "$rc" = "1" ] && [ "$rc0" = "1" ] && [ "$out0" = "no suites matched: no-such-suite" ] \
   && [ "$out" = "$(printf 'no suites matched: no-such-suite\nsuites asked 1 · ran 0 · not launched 1: no-such-suite (no runner)')" ]; then
  ok "a run that matches no suite: one line as before without the word, and the count line after it with the word, exit 1 both ways"
else
  bad "a run that matches no suite reads differently (rc=$rc, without the word rc=$rc0)" "$out
$out0"
fi

fresh
out=$(runner MERCURY_GATE_JOBS=1 --keep-going aa-green); rc=$?
if [ "$rc" = "0" ] && [ "$(last "$out" 2)" = "suites asked 1 · ran 1 · not launched 0" ] && has "$(last "$out" 1)" '^✅ ALL 1 SUITES GREEN  ·  [0-9]+s total$'; then
  ok "with --keep-going: a green named run says its count too and exits 0"
else
  bad "with --keep-going: a green named run does not say its count (rc=$rc)" "$out"
fi

fresh
out=$(runner MERCURY_GATE_JOBS=1 --keep-going); rc=$?
out0=$(runner MERCURY_GATE_JOBS=1); rc0=$?
if [ "$rc" = "1" ] && [ "$rc0" = "1" ] && [ "$(last "$out" 2)" = "suites asked 2 · ran 2 · not launched 0" ] && ! has "$out0" "$ASKED" \
   && has "$out0" '^  ✅ aa-green ' && has "$(last "$out0" 1)" "$RED_END"; then
  ok "a full run: it never stopped at a red, the word adds the count line to it and nothing prints that line without the word"
else
  bad "a full run reads differently (rc=$rc, without the word rc=$rc0)" "$out
$out0"
fi

fresh
plan0=$(runner MERCURY_GATE_JOBS=1 --plan-only zz-red aa-green); prc0=$?
plan1=$(runner MERCURY_GATE_JOBS=1 --keep-going --plan-only zz-red aa-green); prc1=$?
plan2=$(runner MERCURY_GATE_JOBS=1 --plan-only --keep-going zz-red aa-green); prc2=$?
if [ "$prc0$prc1$prc2" = "000" ] && [ "$plan0" = "$(printf 'aa-green\nzz-red')" ] && [ "$plan1" = "$plan0" ] && [ "$plan2" = "$plan0" ] \
   && [ ! -e "$work/ran/zz-red" ] && [ ! -e "$work/ran/aa-green" ]; then
  ok "--plan-only accepts the word on either side and prints the same plan, running nothing"
else
  bad "--plan-only with the word reads differently (rc=$prc0/$prc1/$prc2)" "$plan0
$plan1
$plan2"
fi

out=$(runner MERCURY_GATE_JOBS=1 --keep-goin aa-green); rc=$?
if [ "$rc" = "2" ] && [ "$out" = "unknown pool option: --keep-goin" ]; then
  ok "a misspelt word is still refused as an unknown option, exit 2"
else
  bad "a misspelt word is not refused (rc=$rc)" "$out"
fi

exit "$fail"
