#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
verdict_py="$here/ci-verdict.py"
fail=0

check() { # label rc want_rc
  local label="$1" rc="$2" want="$3"
  if [ "$rc" = "$want" ]; then echo "  [PASS] $label"; else echo "  [FAIL] $label — rc=$rc want=$want"; fail=1; fi
}

json_has() { # label file python-expr (truthy)
  local label="$1" file="$2" expr="$3"
  if /usr/bin/env python3 -c "import json,sys; v=json.load(open('$file')); sys.exit(0 if ($expr) else 1)"; then
    echo "  [PASS] $label"
  else
    echo "  [FAIL] $label"; fail=1
  fi
}

mk_estate() { # dir suite[:class]... — class defaults to pure; 'none' writes a runner with no header
  local dir="$1"; shift
  local s name cls
  for s in "$@"; do
    name=${s%%:*}; cls=${s#*:}; [ "$cls" = "$s" ] && cls=pure
    mkdir -p "$dir/scripts/$name"
    if [ "$cls" = "none" ]; then
      printf '#!/usr/bin/env bash\n' > "$dir/scripts/$name/run-all.sh"
    else
      printf '#!/usr/bin/env bash\n# gate-class: %s\n' "$cls" > "$dir/scripts/$name/run-all.sh"
    fi
  done
}

row() { # dom cls rc secs retry_rc retry_secs
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6"
}

run_case() { # name work [scope] — expects $work/$name prepared with scripts/ + results/; stdout parked in out.txt
  local name="$1" work="$2" scope="${3:-}"
  (
    cd "$work/$name" && unset GITHUB_STEP_SUMMARY
    if [ -n "$scope" ]; then /usr/bin/env python3 "$verdict_py" results --scope "$scope"; else /usr/bin/env python3 "$verdict_py" results; fi
  ) >"$work/$name/out.txt" 2>&1
}

work="$(mktemp -d "${TMPDIR:-/tmp}/ci-verdict-proof-XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "── ci-verdict refusal axes ──"

mk_estate "$work/ok" alpha:pure beta:cpu gamma:pty
mkdir -p "$work/ok/results/s0"
{ row alpha pure 0 10 - -; row beta cpu 0 20 - -; row gamma pty 0 30 - -; } > "$work/ok/results/s0/results.tsv"
run_case ok "$work"; check "all-green exits 0" "$?" 0
json_has "all-green verdict ok:true, 3 pass" "$work/ok/ci-verdict.json" "v['ok'] and len(v['pass'])==3 and not v['fail']"
json_has "the default scope is the whole estate and defers nothing" "$work/ok/ci-verdict.json" "v['scope']=='all' and v['deferred']=={} and v['unclassed']==[] and v['misplanned']==[]"

mk_estate "$work/red" alpha:pure beta:cpu
mkdir -p "$work/red/results/s0"
{ row alpha pure 0 10 - -; row beta cpu 1 20 - -; } > "$work/red/results/s0/results.tsv"
run_case red "$work"; check "a RED suite exits 1" "$?" 1
json_has "RED names the suite" "$work/red/ci-verdict.json" "v['fail']==['beta']"

mk_estate "$work/miss" alpha:pure beta:cpu gamma:pty
mkdir -p "$work/miss/results/s0"
{ row alpha pure 0 10 - -; row beta cpu 0 20 - -; } > "$work/miss/results/s0/results.tsv"
run_case miss "$work"; check "a MISSING suite refuses (exit 1)" "$?" 1
json_has "missing names gamma" "$work/miss/ci-verdict.json" "v['missing']==['gamma'] and not v['ok']"

mk_estate "$work/dup" alpha:pure
mkdir -p "$work/dup/results/s0" "$work/dup/results/s1"
row alpha pure 0 10 - - > "$work/dup/results/s0/results.tsv"
row alpha pure 0 11 - - > "$work/dup/results/s1/results.tsv"
run_case dup "$work"; check "a DUPLICATED suite refuses (exit 1)" "$?" 1
json_has "duplicated names alpha" "$work/dup/ci-verdict.json" "v['duplicated']==['alpha']"

mk_estate "$work/torn" alpha:pure
mkdir -p "$work/torn/results/s0"
printf 'alpha\tpure\t0\t10\t-\n' > "$work/torn/results/s0/results.tsv"
run_case torn "$work"; check "a TORN row cannot pass a suite (exit 1)" "$?" 1
json_has "torn row ⇒ alpha missing" "$work/torn/ci-verdict.json" "v['missing']==['alpha']"

mk_estate "$work/empty" alpha:pure beta:cpu
mkdir -p "$work/empty/results/s0"
: > "$work/empty/results/s0/results.tsv"
run_case empty "$work"; check "an EMPTY results tree refuses (exit 1)" "$?" 1

mk_estate "$work/extra" alpha:pure
mkdir -p "$work/extra/results/s0"
{ row alpha pure 0 10 - -; row zeta pure 0 5 - -; } > "$work/extra/results/s0/results.tsv"
run_case extra "$work"; check "an UNKNOWN row refuses (exit 1) — wrong-attribution" "$?" 1
json_has "unknown names zeta" "$work/extra/ci-verdict.json" "v['unknown']==['zeta']"

mk_estate "$work/flake" alpha:pty
mkdir -p "$work/flake/results/s0"
row alpha pty 1 30 0 25 > "$work/flake/results/s0/results.tsv"
run_case flake "$work"; check "a solo-green flake passes (exit 0)" "$?" 0
json_has "the flake is RECORDED, never silent" "$work/flake/ci-verdict.json" "v['ok'] and v['pass']==['alpha'] and len(v['flakes'])==1 and v['flakes'][0]['suite']=='alpha'"

echo "── the split ──"

mk_estate "$work/rel" alpha:pure beta:cpu gamma:pty xi:exclusive
mkdir -p "$work/rel/results/s0"
{ row alpha pure 0 10 - -; row beta cpu 0 20 - -; row xi exclusive 0 5 - -; } > "$work/rel/results/s0/results.tsv"
run_case rel "$work" release; check "release scope: the release set alone is a green verdict (exit 0)" "$?" 0
json_has "scope release · deferred.drives names gamma · nothing missing or misplanned" "$work/rel/ci-verdict.json" "v['ok'] and v['scope']=='release' and v['deferred']=={'drives':['gamma']} and v['missing']==[] and v['misplanned']==[] and sorted(v['pass'])==['alpha','beta','xi']"
if grep -q 'deferred to the drives verdict (1 suites, not covered here): gamma' "$work/rel/out.txt" && grep -q 'Gate verdict (release scope)' "$work/rel/out.txt"; then
  echo "  [PASS] the release summary names its scope and the deferred drives"
else
  echo "  [FAIL] release summary"; sed 's/^/      /' "$work/rel/out.txt" | head -8; fail=1
fi

mk_estate "$work/mis" alpha:pure gamma:pty
mkdir -p "$work/mis/results/s0"
{ row alpha pure 0 10 - -; row gamma pty 0 30 - -; } > "$work/mis/results/s0/results.tsv"
run_case mis "$work" release; check "a row outside the scope refuses (exit 1)" "$?" 1
json_has "misplanned names gamma; alpha still passes" "$work/mis/ci-verdict.json" "v['misplanned']==['gamma'] and not v['ok'] and 'alpha' in v['pass']"

mk_estate "$work/drv" alpha:pure beta:cpu gamma:pty xi:exclusive
mkdir -p "$work/drv/results/s0"
row gamma pty 0 30 - - > "$work/drv/results/s0/results.tsv"
run_case drv "$work" drives; check "drives scope: the pty set alone is a green verdict (exit 0)" "$?" 0
json_has "scope drives · deferred.release names the three release suites" "$work/drv/ci-verdict.json" "v['ok'] and v['scope']=='drives' and v['deferred']=={'release':['alpha','beta','xi']} and v['pass']==['gamma']"
grep -q 'Drives verdict' "$work/drv/out.txt" && echo "  [PASS] the drives summary is titled as the drives verdict" || { echo "  [FAIL] drives summary title"; fail=1; }

mk_estate "$work/drvmiss" alpha:pure gamma:pty
mkdir -p "$work/drvmiss/results/s0"
: > "$work/drvmiss/results/s0/results.tsv"
run_case drvmiss "$work" drives; check "drives scope with no pty row refuses (exit 1)" "$?" 1
json_has "missing names gamma only — the deferred release suite is not missing" "$work/drvmiss/ci-verdict.json" "v['missing']==['gamma'] and v['deferred']=={'release':['alpha']}"

mk_estate "$work/uncl" alpha:pure delta:none
mkdir -p "$work/uncl/results/s0"
row alpha pure 0 10 - - > "$work/uncl/results/s0/results.tsv"
run_case uncl "$work"; check "an unclassed suite refuses the whole-estate verdict (exit 1)" "$?" 1
json_has "unclassed names delta (whole estate)" "$work/uncl/ci-verdict.json" "v['unclassed']==['delta'] and not v['ok']"
run_case uncl "$work" release; check "…and the release verdict (exit 1)" "$?" 1
json_has "unclassed names delta in the release scope; delta is expected by no scope" "$work/uncl/ci-verdict.json" "v['unclassed']==['delta'] and 'delta' not in v['missing'] and v['deferred']=={'drives':[]}"

mk_estate "$work/notes" alpha:pty
mkdir -p "$work/notes/results/s0"
row alpha pty 1 30 0 25 > "$work/notes/results/s0/results.tsv"
printf 'alpha\tattempt 1: [ptydrive] UNFIRED-SENDS: 1 of 3 sends never became due — first stuck: 4500:hello\n' > "$work/notes/results/s0/notes.tsv"
run_case notes "$work" drives; check "a flake with a note is still a green drives verdict (exit 0)" "$?" 0
json_has "notes carry the suite's first stuck send" "$work/notes/ci-verdict.json" "v['notes']=={'alpha':'attempt 1: [ptydrive] UNFIRED-SENDS: 1 of 3 sends never became due — first stuck: 4500:hello'}"
grep -q '| ✅ alpha | pty | 1 | 30 | rc 0 in 25s | attempt 1: \[ptydrive\] UNFIRED-SENDS: 1 of 3 sends never became due — first stuck: 4500:hello |' "$work/notes/out.txt" \
  && echo "  [PASS] the per-suite table carries suite · class · rc · secs · retry · first stuck send" \
  || { echo "  [FAIL] table row"; grep alpha "$work/notes/out.txt" | sed 's/^/      /'; fail=1; }

mk_estate "$work/bogus" alpha:pure
mkdir -p "$work/bogus/results/s0"
row alpha pure 0 10 - - > "$work/bogus/results/s0/results.tsv"
run_case bogus "$work" bogus; check "--scope bogus is refused (exit 2)" "$?" 2

echo
if [ "$fail" = "0" ]; then echo "✅ CI-VERDICT PROOF PASS"; else echo "❌ CI-VERDICT PROOF RED"; fi
exit "$fail"
