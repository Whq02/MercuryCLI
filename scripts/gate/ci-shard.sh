#!/usr/bin/env bash
# ============================================================================
#  scripts/gate/ci-shard.sh — one CI shard of the hosted gate.
#
#  Usage: ci-shard.sh <shard-index|darwin> <shard-total> [--class release|drives|all] [--plan-only]
#
#  TWO VERDICTS, ONE PLANNER. The estate splits by each suite's `# gate-class:`
#  header into the RELEASE set (pure · cpu · exclusive — deterministic,
#  in-process, the verdict a tag may carry) and the DRIVES set (pty — real
#  terminals booted through the capture engines, whose wall follows the
#  runner). `--class release` plans only the first, `--class drives` only the
#  second, `--class all` (the default) the whole estate as one plan. A suite
#  with no valid header belongs to NEITHER split plan: it is named loudly here
#  and refused by the verdict (no suite may fall through the split).
#  `--plan-only` prints the bucket and exits without seeding or running.
#
#  Deterministic bucketing: every job enumerates the SAME suite estate
#  (scripts/*/run-all.sh minus scripts/gate/ci-darwin-suites.txt), keeps the
#  planned class, orders it longest-first from scripts/gate/duration-seed.tsv
#  (wall-clock only — a stale row costs balance, never a verdict), and
#  greedy-assigns to the emptiest bucket with name tiebreaks — so shard K
#  computes its own bucket without coordination. `darwin` runs the straggler
#  list (filtered by the same class) instead.
#
#  Each suite runs SEQUENTIALLY through scripts/gate/run-suite.sh — the same
#  watchdog + tree-kill unit as the local pool. One suite at a time per runner
#  ⇒ pty contention is zero and the exclusive class holds by construction.
#
#  FLAKE DOCTRINE (the local ledger's CI mirror, unchanged per class): a
#  pty-class RED re-runs once — RECORDED in results.tsv and printed loudly,
#  never silent. pure/cpu/exclusive REDs are genuine and fail directly. A
#  TREE-KILLED attempt (the watchdog's $dom.hang sidecar — its own testimony,
#  never a text scrape: the machinery self-test lawfully PRINTS marker text)
#  never re-runs: a timeout is not a flake, and the re-run is how one hang
#  doubled into a wedged job (run 33148028015 — four shards died with their
#  bucket-tails unreported). The re-run is also BUDGETED (gate run 2's
#  throughput lesson: every long red re-ran solo, roughly doubling its cost —
#  ui-5 alone burned 2151 s across two identical reds — and three shards blew
#  the job window): only a first attempt within MERCURY_CI_RETRY_MAX_SECS
#  (default 240 s) earns the solo re-run. Hosted suites run solo by
#  construction, so the flake class the retry absorbs is short-capture
#  jitter; a long red on an uncontended runner is a verdict, and re-buying it
#  wholesale is how the window died.
#
#  HANG LAW: every attempt is capped by a HARD CEILING — default 900 s
#  (MERCURY_SUITE_CEILING), per-suite grants by name in
#  scripts/gate/suite-ceilings.tsv — capping EVERY budget source, the
#  operator's MERCURY_SUITE_TIMEOUT pin included: the pin buys slack for real
#  work, never the right to wedge a shard past the job clock. Each suite's
#  row lands in results.tsv the moment attempt 1 ends (a retry rewrites it),
#  so even a job-clock kill mid-retry leaves the suite NAMED.
#
#  Results: ci-gate-out/results.tsv — dom class rc secs retryRc retrySecs
#  ('-' when no retry ran). ci-gate-out/notes.tsv — dom note: the capture
#  driver's first stuck-send report from the attempt that decided the row
#  (a drive red explains itself in the verdict table). Exit 0 iff every
#  suite ended green.
#
#  Hermetic seams (the ceiling prover's, all defaulting to the real paths):
#  MERCURY_CI_SHARD_SUITES_DIR · MERCURY_CI_SHARD_SEED_FILE ·
#  MERCURY_CI_SHARD_CEILING_FILE · MERCURY_CI_SHARD_OUT.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

IDX=${1:?shard index or 'darwin'}
TOTAL=${2:?shard total}
shift 2
CLASS=all
PLAN_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    (--class) CLASS=${2:?--class wants release|drives|all}; shift 2 ;;
    (--class=*) CLASS=${1#--class=}; shift ;;
    (--plan-only) PLAN_ONLY=1; shift ;;
    (*) echo "ci-shard: unknown argument '$1' (usage: ci-shard.sh <idx|darwin> <total> [--class release|drives|all] [--plan-only])" >&2; exit 2 ;;
  esac
done
case "$CLASS" in (release | drives | all) ;; (*) echo "ci-shard: --class wants release|drives|all (got '$CLASS')" >&2; exit 2 ;; esac
OUT="${MERCURY_CI_SHARD_OUT:-ci-gate-out}"
SUITES_DIR="${MERCURY_CI_SHARD_SUITES_DIR:-scripts}"
SEED_FILE="${MERCURY_CI_SHARD_SEED_FILE:-scripts/gate/duration-seed.tsv}"
CEILING_FILE="${MERCURY_CI_SHARD_CEILING_FILE:-scripts/gate/suite-ceilings.tsv}"

export MERCURY_GATE_PREBUILT=1

# WATCHDOG BUDGET — the local pool's rule (scripts/run-all-suites.sh):
#   max(MERCURY_SUITE_TIMEOUT_FLOOR, 2 × the suite's seed seconds), or
#   MERCURY_SUITE_TIMEOUT for every suite when the operator pins one (the
#   workflow pins the hosted budget that way; the rule is the parity default).
BUDGET_K=2
BUDGET_FLOOR=${MERCURY_SUITE_TIMEOUT_FLOOR:-600}
case "$BUDGET_FLOOR" in ('' | *[!0-9]*) BUDGET_FLOOR=600 ;; esac
BUDGET_OVERRIDE=${MERCURY_SUITE_TIMEOUT:-}
case "$BUDGET_OVERRIDE" in (*[!0-9]*) BUDGET_OVERRIDE= ;; esac
seed_row() { # $1=dom → seed seconds or empty
  sed -n "s/^$1	\([0-9][0-9]*\)$/\1/p" "$SEED_FILE" 2>/dev/null | head -1
}
# HARD CEILING (the hang law): the per-attempt bound no budget source may
# exceed. Default 900 s; a legitimately-long suite earns a bigger ceiling BY
# NAME in the ceiling file — never by raising the default.
CEILING_DEFAULT=${MERCURY_SUITE_CEILING:-900}
case "$CEILING_DEFAULT" in ('' | *[!0-9]*) CEILING_DEFAULT=900 ;; esac
# RETRY BUDGET (the flake doctrine's cost cap): the solo re-run is only
# bought for a first attempt this fast.
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

# THE PLAN. Portable read (macOS bash 3.2 has no mapfile — the darwin lane
# runs this same script). A plan failure must fail the shard LOUDLY: an empty
# bucket from a crashed planner would otherwise pass as a 0-suite green. The
# class filter reads the same `# gate-class:` header suite_class() reads
# below, so the plan and the flake doctrine agree on every suite's class.
PLAN_OUT=$(/usr/bin/python3 - "$IDX" "$TOTAL" "$SUITES_DIR" "$SEED_FILE" "$CLASS" <<'PYEOF'
import glob, os, re, sys

idx, total = sys.argv[1], int(sys.argv[2])
suites_dir, seed_file, wanted = sys.argv[3], sys.argv[4], sys.argv[5]

CLASSES = {
    "release": {"pure", "cpu", "exclusive"},
    "drives": {"pty"},
    "all": {"pure", "cpu", "pty", "exclusive", "undeclared"},
}[wanted]

darwin = set()
try:
    for line in open("scripts/gate/ci-darwin-suites.txt"):
        line = line.split("#")[0].strip()
        if line:
            darwin.add(line)
except FileNotFoundError:
    pass

def class_of(runner):
    for line in open(runner, encoding="utf-8", errors="replace"):
        m = re.match(r"^# gate-class:\s*(\S+)", line)
        if m:
            return m.group(1) if m.group(1) in ("pure", "cpu", "pty", "exclusive") else "undeclared"
    return "undeclared"

runners = {os.path.basename(os.path.dirname(p)): p for p in glob.glob(f"{suites_dir}/*/run-all.sh")}
suites = sorted(runners)
classes = {d: class_of(runners[d]) for d in suites}
if wanted != "all":
    for d in suites:
        if classes[d] == "undeclared":
            print(f"ci-shard: UNCLASSED suite {d} falls outside every plan — declare '# gate-class: pure|cpu|pty|exclusive' in {runners[d]}", file=sys.stderr)
planned = [d for d in suites if classes[d] in CLASSES]

if idx == "darwin":
    for dom in planned:
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

pool = [d for d in planned if d not in darwin]
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

if [ "$PLAN_ONLY" -eq 1 ]; then
  for dom in ${MINE[@]+"${MINE[@]}"}; do printf '%s\n' "$dom"; done
  exit 0
fi

mkdir -p "$OUT"

# FIRST-RUN SEED for the shard's AMBIENT home: the shard's suites share ONE
# explicit home — an inherited MERCURY_CONFIG_DIR, else a scratch under the
# runner's temp dir — exported so every run-suite.sh inherits it (never a
# directory that belongs to another program). Any PTY prover riding that
# ambient home boots into onboarding + the env-key consent card instead of
# chrome unless it is seeded, so seed ONCE per shard through the ONE seeder
# (absent-only; provers with scratch homes seed themselves). A shell mirror
# of firstRunSeed.ts lived here and drifted — it never gained the policy
# block, so ambient-home boots kept a startup network fetch the seeded homes
# had removed (found auditing a hosted gate run). Trust is keyed by the
# checkout root; the seeder reads ANTHROPIC_API_KEY from this env for the
# consent approval.
ambient_home="${MERCURY_CONFIG_DIR:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mercury-proof-home.XXXXXX")}"
export MERCURY_CONFIG_DIR="$ambient_home"
"${BUN:-$HOME/.bun/bin/bun}" run scripts/lib/firstRunSeed.ts "$ambient_home" "$(pwd)"

suite_class() {
  local c
  c=$(sed -n 's/^# gate-class:[[:space:]]*//p' "$SUITES_DIR/$1/run-all.sh" 2>/dev/null | head -1 | tr -d '[:space:]')
  case "$c" in (pure | cpu | pty | exclusive) printf '%s' "$c" ;; (*) printf 'undeclared' ;; esac
}
stuck_note() { # $1=captured output → the capture driver's first stuck-send report, or empty
  grep -a -m1 -E 'UNFIRED-SENDS|UNDELIVERED-SENDS|first stuck:' "$1" 2>/dev/null | tr '\t' ' ' | cut -c1-240
}

: >"$OUT/results.tsv"
: >"$OUT/notes.tsv"
FAILED=0
echo "shard $IDX/$TOTAL ($CLASS): ${#MINE[@]} suites — ${MINE[*]:-none}"
for dom in ${MINE[@]+"${MINE[@]}"}; do
  cls=$(suite_class "$dom")
  bash scripts/gate/run-suite.sh "$SUITES_DIR/$dom/run-all.sh" "$(budget_of "$dom")" "$OUT" "$(budget_note_of "$dom")" >/dev/null 2>&1
  rc=$(cat "$OUT/$dom.rc" 2>/dev/null || echo 1)
  secs=$(cat "$OUT/$dom.secs" 2>/dev/null || echo 0)
  case "$rc" in ('' | *[!0-9]*) rc=1 ;; esac
  case "$secs" in ('' | *[!0-9]*) secs=0 ;; esac
  retry_rc='-'; retry_secs='-'
  # The row lands BEFORE any retry (rewritten after it): a job-clock kill or
  # a cancel mid-retry still leaves this suite NAMED in results.tsv.
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
  # The note names the first stuck send of the attempt that decided the row —
  # the retry's when one ran, else attempt 1's — so a drive red explains
  # itself in the verdict table without the log.
  note=$(stuck_note "$OUT/$dom.out")
  if [ "$retry_rc" != '-' ]; then
    retry_note=$(stuck_note "$OUT/retry/$dom.out")
    if [ -n "$retry_note" ]; then note="retry: $retry_note"; elif [ -n "$note" ]; then note="attempt 1: $note"; fi
  fi
  [ -n "$note" ] && printf '%s\t%s\n' "$dom" "$note" >>"$OUT/notes.tsv"
  final_rc=$rc
  [ "$retry_rc" != '-' ] && final_rc=$retry_rc
  if [ "$final_rc" -eq 0 ]; then
    if [ "$rc" -ne 0 ]; then
      printf '  ✅ %-18s %3ss  (re-run GREEN — runner flake RECORDED)\n' "$dom" "$retry_secs"
      # Name the flake's prover: the first attempt's tail would otherwise be
      # discarded, leaving every green-retry flake unattributable from the log.
      # The tail alone is not enough — a suite that fails an EARLY prover and
      # runs on prints only its last prover's green rows in the last 40 lines,
      # leaving a green-retry flake unattributable.
      # Surface the first attempt's failure rows FIRST, then
      # the tail; the ledger below stays the verdict — this is attribution.
      grep -nE '\[FAIL\]|FAIL:|✗|❌|FAILED|__SUITE_TIMEOUT|TIMEOUT|error:' "$OUT/$dom.out" 2>/dev/null \
        | head -60 | sed 's/^/      │ first-attempt failure row › /'
      sed 's/^/      │ /' "$OUT/$dom.out" 2>/dev/null | tail -40
    else
      printf '  ✅ %-18s %3ss\n' "$dom" "$secs"
    fi
  else
    FAILED=1
    printf '  ❌ %-18s %3ss\n' "$dom" "$secs"
    [ -n "$note" ] && printf '      │ first stuck send › %s\n' "$note"
    sed 's/^/      │ /' "$OUT/$dom.out" 2>/dev/null
    if [ "$retry_rc" != '-' ]; then
      printf '  ❌ %-18s %3ss  (re-run still RED — genuine)\n' "$dom" "$retry_secs"
      sed 's/^/      │ /' "$OUT/retry/$dom.out" 2>/dev/null
    fi
  fi
done

exit "$FAILED"
