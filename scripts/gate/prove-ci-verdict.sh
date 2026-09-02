#!/usr/bin/env bash
# ============================================================================
#  scripts/gate/prove-ci-verdict.sh — the CI aggregate's own proof (audit F6).
#
#  ci-verdict.py is the file that turns 12 shards into ONE closure verdict —
#  "verify your own verification machinery hardest" stopped one file short of
#  it (its only test was production CI). Synthetic estates + results trees in
#  a fixture cwd OUTSIDE the repo (the ambient-state law) exercise every
#  refusal axis: green, RED rc, missing row, duplicated row, torn row,
#  empty tsv, UNKNOWN row (F7 — wrong-attribution refused), flake row.
# ============================================================================
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

mk_estate() { # dir suites...
  local dir="$1"; shift
  for s in "$@"; do mkdir -p "$dir/scripts/$s"; : > "$dir/scripts/$s/run-all.sh"; done
}

row() { # dom cls rc secs retry_rc retry_secs
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6"
}

run_case() { # name — expects $work/$name prepared with scripts/ + results/
  local name="$1" work="$2"
  ( cd "$work/$name" && unset GITHUB_STEP_SUMMARY && /usr/bin/env python3 "$verdict_py" results >/dev/null 2>&1 )
}

work="$(mktemp -d "${TMPDIR:-/tmp}/ci-verdict-proof-XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "── ci-verdict refusal axes ──"

# 1: all green
mk_estate "$work/ok" alpha beta gamma
mkdir -p "$work/ok/results/s0"
{ row alpha pure 0 10 - -; row beta cpu 0 20 - -; row gamma pty 0 30 - -; } > "$work/ok/results/s0/results.tsv"
run_case ok "$work"; check "all-green exits 0" "$?" 0
json_has "all-green verdict ok:true, 3 pass" "$work/ok/ci-verdict.json" "v['ok'] and len(v['pass'])==3 and not v['fail']"

# 2: RED rc
mk_estate "$work/red" alpha beta
mkdir -p "$work/red/results/s0"
{ row alpha pure 0 10 - -; row beta cpu 1 20 - -; } > "$work/red/results/s0/results.tsv"
run_case red "$work"; check "a RED suite exits 1" "$?" 1
json_has "RED names the suite" "$work/red/ci-verdict.json" "v['fail']==['beta']"

# 3: missing row (a shard died / bucketing bug)
mk_estate "$work/miss" alpha beta gamma
mkdir -p "$work/miss/results/s0"
{ row alpha pure 0 10 - -; row beta cpu 0 20 - -; } > "$work/miss/results/s0/results.tsv"
run_case miss "$work"; check "a MISSING suite refuses (exit 1)" "$?" 1
json_has "missing names gamma" "$work/miss/ci-verdict.json" "v['missing']==['gamma'] and not v['ok']"

# 4: duplicated row across shards
mk_estate "$work/dup" alpha
mkdir -p "$work/dup/results/s0" "$work/dup/results/s1"
row alpha pure 0 10 - - > "$work/dup/results/s0/results.tsv"
row alpha pure 0 11 - - > "$work/dup/results/s1/results.tsv"
run_case dup "$work"; check "a DUPLICATED suite refuses (exit 1)" "$?" 1
json_has "duplicated names alpha" "$work/dup/ci-verdict.json" "v['duplicated']==['alpha']"

# 5: torn row (wrong field count) is skipped ⇒ surfaces as missing
mk_estate "$work/torn" alpha
mkdir -p "$work/torn/results/s0"
printf 'alpha\tpure\t0\t10\t-\n' > "$work/torn/results/s0/results.tsv"
run_case torn "$work"; check "a TORN row cannot pass a suite (exit 1)" "$?" 1
json_has "torn row ⇒ alpha missing" "$work/torn/ci-verdict.json" "v['missing']==['alpha']"

# 6: empty results tree
mk_estate "$work/empty" alpha beta
mkdir -p "$work/empty/results/s0"
: > "$work/empty/results/s0/results.tsv"
run_case empty "$work"; check "an EMPTY results tree refuses (exit 1)" "$?" 1

# 7: unknown row — a suite the checkout doesn't declare (F7)
mk_estate "$work/extra" alpha
mkdir -p "$work/extra/results/s0"
{ row alpha pure 0 10 - -; row zeta pure 0 5 - -; } > "$work/extra/results/s0/results.tsv"
run_case extra "$work"; check "an UNKNOWN row refuses (exit 1) — wrong-attribution" "$?" 1
json_has "unknown names zeta" "$work/extra/ci-verdict.json" "v['unknown']==['zeta']"

# 8: flake row — pooled RED, solo retry GREEN ⇒ pass + recorded flake
mk_estate "$work/flake" alpha
mkdir -p "$work/flake/results/s0"
row alpha pty 1 30 0 25 > "$work/flake/results/s0/results.tsv"
run_case flake "$work"; check "a solo-green flake passes (exit 0)" "$?" 0
json_has "the flake is RECORDED, never silent" "$work/flake/ci-verdict.json" "v['ok'] and v['pass']==['alpha'] and len(v['flakes'])==1 and v['flakes'][0]['suite']=='alpha'"

echo
if [ "$fail" = "0" ]; then echo "✅ CI-VERDICT PROOF PASS"; else echo "❌ CI-VERDICT PROOF RED"; fi
exit "$fail"
