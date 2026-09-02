#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

IDX=${1:?shard index or 'darwin'}
TOTAL=${2:?shard total}
OUT="${MERCURY_CI_SHARD_OUT:-ci-gate-out}"
SUITES_DIR="${MERCURY_CI_SHARD_SUITES_DIR:-scripts}"
SEED_FILE="${MERCURY_CI_SHARD_SEED_FILE:-scripts/gate/duration-seed.tsv}"
CEILING_FILE="${MERCURY_CI_SHARD_CEILING_FILE:-scripts/gate/suite-ceilings.tsv}"
mkdir -p "$OUT"

export MERCURY_GATE_PREBUILT=1

BUDGET_K=2
BUDGET_FLOOR=${MERCURY_SUITE_TIMEOUT_FLOOR:-600}
case "$BUDGET_FLOOR" in ('' | *[!0-9]*) BUDGET_FLOOR=600 ;; esac
BUDGET_OVERRIDE=${MERCURY_SUITE_TIMEOUT:-}
case "$BUDGET_OVERRIDE" in (*[!0-9]*) BUDGET_OVERRIDE= ;; esac
seed_row() { # $1=dom → seed seconds or empty
  sed -n "s/^$1	\([0-9][0-9]*\)$/\1/p" "$SEED_FILE" 2>/dev/null | head -1
}
CEILING_DEFAULT=${MERCURY_SUITE_CEILING:-900}
case "$CEILING_DEFAULT" in ('' | *[!0-9]*) CEILING_DEFAULT=900 ;; esac
RETRY_MAX=${MERCURY_CI_RETRY_MAX_SECS:-240}
case "$RETRY_MAX" in ('' | *[!0-9]*) RETRY_MAX=240 ;; esac
ceiling_of() { # $1=dom → ceiling seconds
  local c
  c=$(sed -n "s/^$1	\([0-9][0-9]*\)$/\1/p" "$CEILING_FILE" 2>/dev/null | head -1)
  printf '%s' "${c:-$CEILING_DEFAULT}"
}
budget_of() { # $1=dom — the rule (or the operator pin), CAPPED at the ceiling
  local last b c
  if [ -n "$BUDGET_OVERRIDE" ]; then
    b=$BUDGET_OVERRIDE
  else
    last=$(seed_row "$1")
    b=$(( ${last:-0} * BUDGET_K ))
    [ "$b" -lt "$BUDGET_FLOOR" ] && b=$BUDGET_FLOOR
  fi
  c=$(ceiling_of "$1")
  [ "$b" -gt "$c" ] && b=$c
  printf '%s' "$b"
}
budget_note_of() { # $1=dom — names the ceiling when it is the binding bound
  local c
  c=$(ceiling_of "$1")
  [ "$(budget_of "$1")" -eq "$c" ] && printf 'the %ss suite ceiling — the hang law' "$c"
}

ambient_home="${MERCURY_CONFIG_DIR:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mercury-proof-home.XXXXXX")}"
export MERCURY_CONFIG_DIR="$ambient_home"
"${BUN:-$HOME/.bun/bin/bun}" run scripts/lib/firstRunSeed.ts "$ambient_home" "$(pwd)"

PLAN_OUT=$(/usr/bin/python3 - "$IDX" "$TOTAL" "$SUITES_DIR" "$SEED_FILE" <<'PYEOF'
import glob, os, sys

idx, total = sys.argv[1], int(sys.argv[2])
suites_dir, seed_file = sys.argv[3], sys.argv[4]

darwin = set()
try:
    for line in open("scripts/gate/ci-darwin-suites.txt"):
        line = line.split("#")[0].strip()
        if line:
            darwin.add(line)
except FileNotFoundError:
    pass

suites = sorted(
    os.path.basename(os.path.dirname(p)) for p in glob.glob(f"{suites_dir}/*/run-all.sh")
)

if idx == "darwin":
    for dom in suites:
        if dom in darwin:
            print(dom)
    sys.exit(0)

dur = {}
try:
    for line in open(seed_file):
        parts = line.split("#")[0].split()
        if len(parts) == 2 and parts[1].isdigit():
            dur[parts[0]] = int(parts[1])
except FileNotFoundError:
    pass

pool = [d for d in suites if d not in darwin]
pool.sort(key=lambda d: (-dur.get(d, 30), d))
buckets = [[0, i, []] for i in range(int(total))]
for dom in pool:
    b = min(buckets, key=lambda x: (x[0], x[1]))
    b[0] += dur.get(dom, 30)
    b[2].append(dom)
for dom in buckets[int(idx)][2]:
    print(dom)
PYEOF
) || { echo "❌ shard plan FAILED (planner exited nonzero) — refusing to run an empty bucket as green"; exit 1; }
MINE=()
while IFS= read -r _dom; do
  [ -n "$_dom" ] && MINE+=("$_dom")
done <<<"$PLAN_OUT"

suite_class() {
  local c
  c=$(sed -n 's/^# gate-class:[[:space:]]*//p' "$SUITES_DIR/$1/run-all.sh" 2>/dev/null | head -1 | tr -d '[:space:]')
  case "$c" in (pure | cpu | pty | exclusive) printf '%s' "$c" ;; (*) printf 'undeclared' ;; esac
}

: >"$OUT/results.tsv"
FAILED=0
echo "shard $IDX/$TOTAL: ${#MINE[@]} suites — ${MINE[*]:-none}"
for dom in ${MINE[@]+"${MINE[@]}"}; do
  cls=$(suite_class "$dom")
  bash scripts/gate/run-suite.sh "$SUITES_DIR/$dom/run-all.sh" "$(budget_of "$dom")" "$OUT" "$(budget_note_of "$dom")" >/dev/null 2>&1
  rc=$(cat "$OUT/$dom.rc" 2>/dev/null || echo 1)
  secs=$(cat "$OUT/$dom.secs" 2>/dev/null || echo 0)
  case "$rc" in ('' | *[!0-9]*) rc=1 ;; esac
  case "$secs" in ('' | *[!0-9]*) secs=0 ;; esac
  retry_rc='-'; retry_secs='-'
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$dom" "$cls" "$rc" "$secs" "$retry_rc" "$retry_secs" >>"$OUT/results.tsv"
  hung=0
  [ "$rc" -ne 0 ] && [ -f "$OUT/$dom.hang" ] && hung=1
  if [ "$hung" -eq 1 ]; then
    printf '  ⛔ %-18s HANG — tree-killed at %ss; solo re-run SKIPPED (a timeout is not a flake)\n' "$dom" "$secs"
  elif [ "$rc" -ne 0 ] && { [ "$cls" = "pty" ] || [ "$cls" = "undeclared" ]; } && [ "$secs" -gt "$RETRY_MAX" ]; then
    printf '  ❌ %-18s RED (rc %s, %ss) — solo re-run SKIPPED (first attempt beyond the %ss retry budget; a long red on an uncontended runner is a verdict, not a flake)\n' "$dom" "$rc" "$secs" "$RETRY_MAX"
  elif [ "$rc" -ne 0 ] && { [ "$cls" = "pty" ] || [ "$cls" = "undeclared" ]; }; then
    printf '  ⚠  %-18s RED (rc %s, %ss) — recorded solo re-run, once…\n' "$dom" "$rc" "$secs"
    mkdir -p "$OUT/retry"
    bash scripts/gate/run-suite.sh "$SUITES_DIR/$dom/run-all.sh" "$(budget_of "$dom")" "$OUT/retry" "$(budget_note_of "$dom")" >/dev/null 2>&1
    retry_rc=$(cat "$OUT/retry/$dom.rc" 2>/dev/null || echo 1)
    retry_secs=$(cat "$OUT/retry/$dom.secs" 2>/dev/null || echo 0)
    case "$retry_rc" in ('' | *[!0-9]*) retry_rc=1 ;; esac
    grep -v "^$dom	" "$OUT/results.tsv" >"$OUT/results.tsv.tmp"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$dom" "$cls" "$rc" "$secs" "$retry_rc" "$retry_secs" >>"$OUT/results.tsv.tmp"
    mv -f "$OUT/results.tsv.tmp" "$OUT/results.tsv"
  fi
  final_rc=$rc
  [ "$retry_rc" != '-' ] && final_rc=$retry_rc
  if [ "$final_rc" -eq 0 ]; then
    if [ "$rc" -ne 0 ]; then
      printf '  ✅ %-18s %3ss  (re-run GREEN — runner flake RECORDED)\n' "$dom" "$retry_secs"
      grep -nE '\[FAIL\]|FAIL:|✗|❌|FAILED|__SUITE_TIMEOUT|TIMEOUT|error:' "$OUT/$dom.out" 2>/dev/null \
        | head -60 | sed 's/^/      │ first-attempt failure row › /'
      sed 's/^/      │ /' "$OUT/$dom.out" 2>/dev/null | tail -40
    else
      printf '  ✅ %-18s %3ss\n' "$dom" "$secs"
    fi
  else
    FAILED=1
    printf '  ❌ %-18s %3ss\n' "$dom" "$secs"
    sed 's/^/      │ /' "$OUT/$dom.out" 2>/dev/null
    if [ "$retry_rc" != '-' ]; then
      printf '  ❌ %-18s %3ss  (re-run still RED — genuine)\n' "$dom" "$retry_secs"
      sed 's/^/      │ /' "$OUT/retry/$dom.out" 2>/dev/null
    fi
  fi
done

exit "$FAILED"
