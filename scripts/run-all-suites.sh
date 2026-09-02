#!/usr/bin/env bash
# ============================================================================
#  scripts/run-all-suites.sh — the ONE green-gate command.
#
#  The project gate is "the N domain proof suites" (crew, subagent-doctrine,
#  commit-gate, memory, identity, substrate, party, goal, ui, …). Globs
#  scripts/*/run-all.sh dynamically → any new suite auto-joins the gate (no
#  hardcoded list to go stale; parity has no run-all.sh, so that tooling dir is
#  skipped for free). Quiet on green (one PASS line + timing per suite), LOUD
#  on red (dumps the failing suite's full output). Optional args run a subset:
#    scripts/run-all-suites.sh            # everything
#    scripts/run-all-suites.sh ui goal    # just those two
#  Exit 0 ⇒ all green; exit 1 ⇒ at least one suite red.
#
#  CLASS-AWARE LANES:
#  every suite declares its resource class in its run-all.sh header —
#      # gate-class: pure|cpu|pty|exclusive
#    pty        real terminal captures (vshot/ptydrive) — wall-clock
#               sensitive. Lane cap MERCURY_GATE_PTY_MAX, slot weight 2.
#    cpu        heavy load (dist boots, tsc, long renders). Slot weight 2.
#    pure       light script checks. Slot weight 1, lane cap CORES-2.
#    exclusive  time-as-contract (bench ops/sec floors) — runs ALONE after
#               the pool drains.
#  Slot budget = CORES (a pty/cpu suite holds 2 slots). Queues are ordered
#  LONGEST-FIRST from the last full verdict's duration rows (cold-start:
#  scripts/gate/duration-seed.tsv) so the critical path starts at t0 — a
#  stale duration can never change a verdict, only cost seconds. An
#  UNDECLARED suite schedules conservatively in the pty lane and the gate
#  suite's registry prover goes RED until it declares.
#  MERCURY_GATE_JOBS: unset ⇒ CORES slots · =1 ⇒ strict-sequential ·
#  N>1 ⇒ 2·N slots (the old "N concurrent suites" vocabulary, weighted).
#  MERCURY_GATE_PTY_MAX: pty lane cap (default 3 — measured adoption; pair a
#  change with VSHOT_SLOTS, vshot.py's machine-wide capture semaphore, which
#  is the real binding resource behind the cap).
#  The per-suite execution unit is scripts/gate/run-suite.sh (watchdog +
#  tree-kill; proven by scripts/gate/). Safe because: suites never write the
#  repo tree (verified post-gate clean), no fixed ports, and dist is built
#  exactly ONCE per pool in Phase 0 (below) — never again inside a suite.
#
#  Phase 0 (FULL runs only): build dist ONCE up front — every suite then
#  tests the SAME current build, and a broken build fails fast as one clear
#  line instead of surfacing as scattered suite weirdness. Suites see
#  MERCURY_GATE_PREBUILT=1 and skip their own rebuild. The dist cache
#  (scripts/gate/dist-cache-check.sh, content-bound) skips the build when dist
#  already matches the working content. MERCURY_GATE_NO_PREBUILD=1 skips the
#  build on the operator's word that dist is fresh — the suites still see
#  MERCURY_GATE_PREBUILT=1, so the one-build law holds either way; subset runs
#  never prebuild. A dist mutation DURING the pool (a suite rebuilding behind
#  the gate's back) is a tripwire: loud line + a timeline row naming the
#  suites in flight.
#
#  WATCHDOG BUDGET (measured, never a guessed ceiling): each suite runs under
#      budget = max(MERCURY_SUITE_TIMEOUT_FLOOR, K × its last recorded pooled
#      seconds)      with K = 2 and the floor default 600 s.
#  A suite that legitimately grows is never killed at a stale ceiling (its own
#  last time sets the bar), a hung suite still dies (within 2× its normal
#  wall, or the floor for a small/unknown suite), and MERCURY_SUITE_TIMEOUT
#  stays the operator's override (every suite runs under exactly that many
#  seconds when it is set). The budget each suite ran under is recorded in
#  the verdict timeline.
#
#  FLAKE RE-RUNS (MERCURY_GATE_RETRY): a pty-lane suite RED in the pool is
#  re-run, recorded, never silent —
#      escalate    (default) re-run IMMEDIATELY inside the pool at the head of
#                  the pty lane; if THAT is red too, one SOLO re-run after the
#                  drain (the contention-free verdict). The verdict row keeps
#                  every attempt.
#      in-pool     the immediate in-pool re-run only — exactly one re-run.
#      after-drain one solo re-run after the drain (the serialized posture).
#  Measured on the 146-suite estate: the after-drain tail was half the wall
#  (eight solo re-runs, 2,658 s of 5,306 s); in-pool re-runs fill the pool's
#  own tail instead. pure/cpu/exclusive reds are genuine and fail directly.
#
#  SELF-TIMING: every launch/finish is an event; the verdict carries a
#  schema-versioned "timeline" (per-run offsets, lane, weight, queue wait,
#  budget, cpu seconds; phases; lane occupancy, starvation and idle-under-cap
#  seconds; the slot-handoff critical path; top wall contributors at suite
#  AND prover granularity, parsed from `── <prover>  <N>s` lines in suite
#  output) and a compact stopwatch prints at the end of every full run —
#  scripts/gate/timeline.py is the analyzer.
#
#  MERCURY_GATE_SUITES_DIR (hermetic seam, the scheduler's own provers): point
#  the gate at a synthetic suite estate. When overridden the run is HERMETIC —
#  no Phase-0 prebuild unless MERCURY_GATE_BUILD_CMD names a command (the
#  one-build prover's counting stub), durations come from the seed only
#  (MERCURY_GATE_SEED_FILE overrides it), the dist tripwire watches only the
#  file MERCURY_GATE_DIST_MANIFEST names, and no verdict write unless
#  MERCURY_GATE_VERDICT_FILE names a target explicitly. The real estate never
#  rides these envs.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/project-home.sh

SUITES_DIR=${MERCURY_GATE_SUITES_DIR:-scripts}
HERMETIC=0
[ "$SUITES_DIR" != "scripts" ] && HERMETIC=1

want=("$@")
in_want() {
  [ "${#want[@]}" -eq 0 ] && return 0
  local w
  for w in "${want[@]}"; do [ "$w" = "$1" ] && return 0; done
  return 1
}

T_START=$SECONDS

# ── concurrency model ───────────────────────────────────────────────────────
CORES=$( (sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8) | head -1 )
case "$CORES" in ('' | *[!0-9]*) CORES=8 ;; esac
JOBS=${MERCURY_GATE_JOBS:-}
case "$JOBS" in (*[!0-9]*) JOBS= ;; esac
SEQUENTIAL=0
SLOTS_TOTAL=$CORES
[ "${JOBS:-}" = "1" ] && SEQUENTIAL=1
if [ -n "${JOBS:-}" ] && [ "$JOBS" -gt 1 ]; then SLOTS_TOTAL=$(( JOBS * 2 )); fi
# MERCURY_GATE_PTY_MAX: the pty-lane cap, default 3 (the measured adoption:
# zero capture flakes at 3/3 on a loaded pool against two retries at 2/2).
# Non-numeric/zero falls back to the default.
PTY_MAX=${MERCURY_GATE_PTY_MAX:-3}
case "$PTY_MAX" in ('' | *[!0-9]*) PTY_MAX=3 ;; esac
[ "$PTY_MAX" -lt 1 ] && PTY_MAX=1
PURE_MAX=$(( CORES - 2 )); [ "$PURE_MAX" -lt 1 ] && PURE_MAX=1

# ── flake re-run policy ────────────────────────────────────────────────────
RETRY_MODE=${MERCURY_GATE_RETRY:-escalate}
case "$RETRY_MODE" in (escalate | in-pool | after-drain) ;; (*) RETRY_MODE=escalate ;; esac

# ── watchdog budget rule ───────────────────────────────────────────────────
BUDGET_K=2
BUDGET_FLOOR=${MERCURY_SUITE_TIMEOUT_FLOOR:-600}
case "$BUDGET_FLOOR" in ('' | *[!0-9]*) BUDGET_FLOOR=600 ;; esac
[ "$BUDGET_FLOOR" -lt 1 ] && BUDGET_FLOOR=600
BUDGET_OVERRIDE=${MERCURY_SUITE_TIMEOUT:-}
case "$BUDGET_OVERRIDE" in (*[!0-9]*) BUDGET_OVERRIDE= ;; esac
[ -n "$BUDGET_OVERRIDE" ] && [ "$BUDGET_OVERRIDE" -lt 1 ] && BUDGET_OVERRIDE=

# ── discover + filter suites (glob order = alphabetical) ──────────────────
suites=()
for runner in "$SUITES_DIR"/*/run-all.sh; do
  [ -e "$runner" ] || continue
  dom=$(basename "$(dirname "$runner")")
  in_want "$dom" || continue
  suites+=("$dom")
done
total=${#suites[@]}
if [ "$total" -eq 0 ]; then echo "no suites matched: ${want[*]:-}"; exit 1; fi

# ── class + duration lookups ────────────────────────────────────────────────
suite_class() { # $1=dom → pure|cpu|pty|exclusive|undeclared
  local c
  c=$(sed -n 's/^# gate-class:[[:space:]]*//p' "$SUITES_DIR/$1/run-all.sh" 2>/dev/null | head -1 | tr -d '[:space:]')
  case "$c" in (pure | cpu | pty | exclusive) printf '%s' "$c" ;; (*) printf 'undeclared' ;; esac
}
pty_lane() { # $1=class → 0 when the class rides the pty lane (declared or undeclared-conservative)
  [ "$1" = "pty" ] || [ "$1" = "undeclared" ]
}

# Duration table: the last full verdict's rows first (written by this script's
# verdict block, read from the ONE project store), then the committed
# cold-start seed. WALL-CLOCK ONLY — a stale or missing row costs seconds,
# never a verdict. Default 30 s for an unknown suite. Hermetic runs read the
# seed alone (the real verdict never steers a synthetic estate).
VERDICT_FILE="$(project_store_dir "$PWD" gate)/verdict.json"
SEED_FILE=scripts/gate/duration-seed.tsv
if [ "$HERMETIC" -eq 1 ]; then
  [ -n "${MERCURY_GATE_SEED_FILE:-}" ] && SEED_FILE=$MERCURY_GATE_SEED_FILE
fi
DUR_TABLE=$(
  {
    if [ "$HERMETIC" -eq 0 ]; then
      python3 - "$VERDICT_FILE" 2>/dev/null <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1])).get("durations") or {}
    for k, v in sorted(d.items()):
        print(k, int(v))
except Exception:
    pass
PY
    fi
    sed -n 's/^\([A-Za-z0-9-][A-Za-z0-9-]*\)	\([0-9][0-9]*\)$/\1 \2/p' "$SEED_FILE" 2>/dev/null
  } || true
)
dur_row() { # $1=dom → the recorded seconds, or empty when no row exists (first hit wins)
  printf '%s\n' "$DUR_TABLE" | awk -v k="$1" '$1==k{print $2; exit}'
}
dur_of() { # $1=dom → seconds for ordering (30 when unknown)
  local d
  d=$(dur_row "$1")
  printf '%s' "${d:-30}"
}
budget_of() { # $1=dom → the watchdog seconds this suite runs under
  local last b
  if [ -n "$BUDGET_OVERRIDE" ]; then printf '%s' "$BUDGET_OVERRIDE"; return; fi
  last=$(dur_row "$1")
  b=$(( ${last:-0} * BUDGET_K ))
  [ "$b" -lt "$BUDGET_FLOOR" ] && b=$BUDGET_FLOOR
  printf '%s' "$b"
}
budget_note() { # $1=dom → the rule text the kill marker carries
  local last
  if [ -n "$BUDGET_OVERRIDE" ]; then printf 'MERCURY_SUITE_TIMEOUT=%s' "$BUDGET_OVERRIDE"; return; fi
  last=$(dur_row "$1")
  if [ -n "$last" ]; then
    printf 'budget = max(%s s floor, %s × %s s last pooled); MERCURY_SUITE_TIMEOUT overrides' "$BUDGET_FLOOR" "$BUDGET_K" "$last"
  else
    printf 'budget = the %s s floor (no duration row — a first appearance; seed it in scripts/gate/duration-seed.tsv or set MERCURY_SUITE_TIMEOUT)' "$BUDGET_FLOOR"
  fi
}

# ── per-class queues, longest-first ─────────────────────────────────────────
q_pty=(); q_cpu=(); q_pure=(); q_excl=(); UNDECLARED=()
sorted_by_dur=$(for dom in ${suites[@]+"${suites[@]}"}; do printf '%s %s\n' "$(dur_of "$dom")" "$dom"; done | sort -rn -k1,1)
while read -r _secs dom; do
  [ -n "$dom" ] || continue
  case "$(suite_class "$dom")" in
    pty) q_pty+=("$dom") ;;
    cpu) q_cpu+=("$dom") ;;
    pure) q_pure+=("$dom") ;;
    exclusive) q_excl+=("$dom") ;;
    undeclared) UNDECLARED+=("$dom"); q_pty+=("$dom") ;;
  esac
done <<<"$sorted_by_dur"

# ── Phase 0: one dist for the whole gate (full runs only) ──────────────────
# DIST CACHE: skip the rebuild when dist was built from EXACTLY the current
# working content — manifest.buildTree equals the current content write-tree
# (scripts/gate/dist-cache-check.sh; fail-closed: any doubt, any content
# change, any degraded artifact ⇒ rebuild). MERCURY_GATE_DIST_CACHE=0 forces
# the rebuild.
PREBUILD_KIND=none   # none | hit | built | skipped
PREBUILD_S=0
if [ "${#want[@]}" -eq 0 ]; then
  if [ "${MERCURY_GATE_NO_PREBUILD:-0}" = "1" ]; then
    if [ "$HERMETIC" -eq 0 ] && [ ! -f dist/manifest.json ]; then
      # the operator vouched for a dist that is not there — a dist-bound suite
      # will build for itself, and two of them will race on the same files
      echo "  ⚠  MERCURY_GATE_NO_PREBUILD=1 but dist/manifest.json is absent — dist-bound suites will build for themselves (and race); unset it or build first"
    fi
    PREBUILD_KIND=skipped
    export MERCURY_GATE_PREBUILT=1
    echo "  ⚙  prebuild skipped (MERCURY_GATE_NO_PREBUILD=1) — suites reuse the dist on the floor"
  elif [ "$HERMETIC" -eq 0 ] || [ -n "${MERCURY_GATE_BUILD_CMD:-}" ]; then
    t0=$SECONDS
    cache_line=""
    if [ "$HERMETIC" -eq 0 ] && [ "${MERCURY_GATE_DIST_CACHE:-1}" != "0" ]; then
      cache_line=$(bash scripts/gate/dist-cache-check.sh 2>/dev/null || true)
    fi
    case "$cache_line" in
      (HIT\ *)
        PREBUILD_KIND=hit
        PREBUILD_S=$(( SECONDS - t0 ))
        printf '  ⚙  dist cache HIT (content tree %.12s…) — prebuild skipped (%ds)\n' "${cache_line#HIT }" "$PREBUILD_S"
        export MERCURY_GATE_PREBUILT=1
        ;;
      (*)
        build_log=$(mktemp)
        if [ "$HERMETIC" -eq 1 ]; then
          bash -c "$MERCURY_GATE_BUILD_CMD" >"$build_log" 2>&1; build_rc=$?
        else
          "${BUN:-$HOME/.bun/bin/bun}" run build.ts >"$build_log" 2>&1; build_rc=$?
        fi
        PREBUILD_S=$(( SECONDS - t0 ))
        if [ "$build_rc" -eq 0 ]; then
          PREBUILD_KIND=built
          printf '  ⚙  prebuild dist      %3ds\n' "$PREBUILD_S"
          export MERCURY_GATE_PREBUILT=1
        else
          echo "  ❌ prebuild FAILED — the gate tests dist, so nothing below could be trusted:"
          sed 's/^/      │ /' "$build_log"
          rm -f "$build_log"
          exit 1
        fi
        rm -f "$build_log"
        ;;
    esac
  fi
fi

# Dist tripwire: the manifest's mtime after Phase 0; a change during the pool
# means a suite rebuilt behind the gate's back. Armed only when the gate
# vouched for dist (Phase 0 ran or was skipped on the operator's word) — a
# subset run has no Phase 0 and its suites rebuild as standalone runs do.
# Hermetic runs watch the file MERCURY_GATE_DIST_MANIFEST names (the
# tripwire's own prover), never dist/.
DIST_MANIFEST=""
if [ "$HERMETIC" -eq 1 ]; then
  DIST_MANIFEST=${MERCURY_GATE_DIST_MANIFEST:-}
elif [ "$PREBUILD_KIND" != "none" ]; then
  DIST_MANIFEST=dist/manifest.json
fi
dist_stamp() { [ -n "$DIST_MANIFEST" ] && { stat -f %m "$DIST_MANIFEST" 2>/dev/null || stat -c %Y "$DIST_MANIFEST" 2>/dev/null || echo ""; }; }
DIST_STAMP0=$(dist_stamp)
DIST_MUTATED=0

# ── dispatch ────────────────────────────────────────────────────────────────
outdir=$(mktemp -d "${TMPDIR:-/tmp}/hermes-gate.XXXXXX")
mkdir -p "$outdir/retry1" "$outdir/retry2"
EVENTS="$outdir/events.log"
: >"$EVENTS"
running_doms=(); running_pids=(); running_cls=(); running_wt=(); running_dir=(); running_att=()
cleanup() {
  local p
  for p in ${running_pids[@]+"${running_pids[@]}"}; do kill "$p" 2>/dev/null; done
  rm -rf "$outdir"
}
trap cleanup EXIT

declare -a PASS=() FAIL=() PRINTED=()
was_printed() { local d; for d in ${PRINTED[@]+"${PRINTED[@]}"}; do [ "$d" = "$1" ] && return 0; done; return 1; }
drop_fail() { # $1=dom — a re-run turned it green
  local keep=() d
  for d in ${FAIL[@]+"${FAIL[@]}"}; do [ "$d" = "$1" ] || keep+=("$d"); done
  FAIL=(${keep[@]+"${keep[@]}"})
}

# Flake ledger (parallel arrays, one row per pty-lane pool RED): the pooled
# attempt, the in-pool re-run (attempt 2) and the solo re-run (attempt 3).
FLK_DOM=(); FLK_PRC=(); FLK_PSEC=(); FLK_R1RC=(); FLK_R1SEC=(); FLK_R1T0=(); FLK_R2RC=(); FLK_R2SEC=(); FLK_R2T0=()
flk_idx() { # $1=dom → index or -1
  local i=0
  for d in ${FLK_DOM[@]+"${FLK_DOM[@]}"}; do [ "$d" = "$1" ] && { printf '%s' "$i"; return; }; i=$(( i + 1 )); done
  printf -- '-1'
}

pend_retry=()   # in-pool re-runs waiting for a pty slot
solo_doms=()    # after-drain solo re-runs

slots=0; pty_n=0; pure_n=0; excl_n=0
qi_pty=0; qi_cpu=0; qi_pure=0; qi_excl=0
n_pty=${#q_pty[@]}; n_cpu=${#q_cpu[@]}; n_pure=${#q_pure[@]}; n_excl=${#q_excl[@]}
T_POOL0=$SECONDS
now() { printf '%s' "$(( SECONDS - T_POOL0 ))"; }
# One event line per launch/finish/queue/tripwire — the timeline's source:
#   t kind dom attempt lane wt budget qpty qcpu qpure ptyN pureN slots extra
ev() { # $1=kind $2=dom $3=attempt $4=lane $5=wt $6=budget $7=extra
  printf '%s %s %s %s %s %s %s %s %s %s %s %s %s %s\n' "$(now)" "$1" "$2" "$3" "$4" "$5" "$6" \
    "$(( n_pty - qi_pty + ${#pend_retry[@]} ))" "$(( n_cpu - qi_cpu ))" "$(( n_pure - qi_pure ))" \
    "$pty_n" "$pure_n" "$slots" "$7" >>"$EVENTS"
}

read_num() { # $1=file $2=default — a torn/garbled number reads as the default
  local v
  v=$(cat "$1" 2>/dev/null || echo "$2")
  case "$v" in ('' | *[!0-9]*) v=$2 ;; esac
  printf '%s' "$v"
}

# Print a finished suite's verdict line (and dump its output when red).
print_done() { # $1 = dom  $2 = dir
  local dom=$1 dir=$2 rc dt
  rc=$(read_num "$dir/$dom.rc" 1)   # a torn/garbled rc reads as RED, never a bash error
  dt=$(read_num "$dir/$dom.secs" 0)
  if [ "$rc" -eq 0 ]; then
    PASS+=("$dom"); printf '  ✅ %-18s %3ds\n' "$dom" "$dt"
  else
    FAIL+=("$dom"); printf '  ❌ %-18s %3ds\n' "$dom" "$dt"
    sed 's/^/      │ /' "$dir/$dom.out" 2>/dev/null
  fi
  PRINTED+=("$dom")
}

pure_head_outlasts_cpu() { # the pure queue's head fits the floor AND runs longer than the cpu queue's head
  [ "$qi_pure" -lt "$n_pure" ] && [ "$pure_n" -lt "$PURE_MAX" ] && [ $(( slots + 1 )) -le "$SLOTS_TOTAL" ] \
    && [ "$(dur_of "${q_pure[$qi_pure]}")" -gt "$(dur_of "${q_cpu[$qi_cpu]}")" ]
}

launch() { # $1=dom $2=lane(pty|cpu|pure|exclusive) $3=weight $4=attempt $5=dir — mutates the running_* arrays + lane counters
  local budget
  budget=$(budget_of "$1")
  bash scripts/gate/run-suite.sh "$SUITES_DIR/$1/run-all.sh" "$budget" "$5" "$(budget_note "$1")" >/dev/null 2>&1 &
  running_doms+=("$1"); running_pids+=($!); running_cls+=("$2"); running_wt+=("$3"); running_dir+=("$5"); running_att+=("$4")
  slots=$(( slots + $3 ))
  case "$2" in (pty) pty_n=$(( pty_n + 1 )) ;; (pure) pure_n=$(( pure_n + 1 )) ;; (exclusive) excl_n=$(( excl_n + 1 )) ;; esac
  ev launch "$1" "$4" "$2" "$3" "$budget" "class=$(suite_class "$1")"
}

# A finished attempt: the pooled run reports; a pty-lane RED enqueues its
# in-pool re-run; a re-run either clears the suite or escalates/finalizes.
finish() { # $1=dom $2=lane $3=attempt $4=dir
  local dom=$1 lane=$2 att=$3 dir=$4 rc secs cpu i
  rc=$(read_num "$dir/$dom.rc" 1); secs=$(read_num "$dir/$dom.secs" 0); cpu=$(read_num "$dir/$dom.cpu" 0)
  ev finish "$dom" "$att" "$lane" - - "rc=$rc,secs=$secs,cpu=$cpu"
  if [ "$att" -eq 1 ]; then
    print_done "$dom" "$dir"
    if [ "$rc" -ne 0 ] && [ "$SEQUENTIAL" -eq 0 ] && pty_lane "$(suite_class "$dom")"; then
      FLK_DOM+=("$dom"); FLK_PRC+=("$rc"); FLK_PSEC+=("$secs"); FLK_R1RC+=(-); FLK_R1SEC+=(-); FLK_R1T0+=(-); FLK_R2RC+=(-); FLK_R2SEC+=(-); FLK_R2T0+=(-)
      if [ "$RETRY_MODE" = "after-drain" ]; then
        solo_doms+=("$dom")
        printf '  ⚠  %-18s RED in pool (rc %s, %ss) — solo re-run after the drain (recorded, once)\n' "$dom" "$rc" "$secs"
      else
        pend_retry+=("$dom")
        printf '  ⚠  %-18s RED in pool (rc %s, %ss) — in-pool re-run queued at the head of the pty lane (recorded)\n' "$dom" "$rc" "$secs"
        ev retryq "$dom" 2 pty - - -
      fi
    fi
    return
  fi
  i=$(flk_idx "$dom")
  if [ "$att" -eq 2 ]; then
    FLK_R1RC[$i]=$rc; FLK_R1SEC[$i]=$secs
    if [ "$rc" -eq 0 ]; then
      drop_fail "$dom"; PASS+=("$dom")
      printf '  ✅ %-18s %3ds  (in-pool re-run GREEN — pool flake RECORDED in the verdict)\n' "$dom" "$secs"
    elif [ "$RETRY_MODE" = "escalate" ]; then
      solo_doms+=("$dom")
      printf '  ⚠  %-18s %3ds  (in-pool re-run still RED, rc %s — solo re-run after the drain, recorded)\n' "$dom" "$secs" "$rc"
    else
      printf '  ❌ %-18s %3ds  (in-pool re-run still RED — genuine; re-run alone: bash scripts/%s/run-all.sh)\n' "$dom" "$secs" "$dom"
      sed 's/^/      │ /' "$dir/$dom.out" 2>/dev/null
    fi
  fi
}

echo "running domain proof suites… ($total suites · slots=$SLOTS_TOTAL · pty≤$PTY_MAX · pure≤$PURE_MAX · retry=$RETRY_MODE · budget=$([ -n "$BUDGET_OVERRIDE" ] && echo "${BUDGET_OVERRIDE}s pinned" || echo "max(${BUDGET_FLOOR}s, ${BUDGET_K}×last)")$([ "$SEQUENTIAL" -eq 1 ] && echo ' · SEQUENTIAL'))"
for u in ${UNDECLARED[@]+"${UNDECLARED[@]}"}; do
  printf '  ⚠  %-18s no "# gate-class:" header — scheduled conservatively (pty lane); declare pure|cpu|pty|exclusive\n' "$u"
done

# FAIL-FAST is an ITERATION-RUNG behavior (subset runs only): a RED stops
# LAUNCHING further suites — loudly, never silently — because the operator is
# iterating and wants the verdict now. A FULL run never fail-fasts: the
# closure gate's job is complete coverage of every suite, both colors. A
# queued re-run is not a further suite; it still runs.
FAILFAST=0
failfast_armed=0
[ "${#want[@]}" -gt 0 ] && failfast_armed=1

if [ "$SEQUENTIAL" -eq 1 ]; then
  for dom in ${q_pty[@]+"${q_pty[@]}"} ${q_cpu[@]+"${q_cpu[@]}"} ${q_pure[@]+"${q_pure[@]}"} ${q_excl[@]+"${q_excl[@]}"}; do
    if [ "$FAILFAST" -eq 1 ]; then
      printf '  ⏭  %-18s not launched (fail-fast: an iteration rung stops on RED)\n' "$dom"
      continue
    fi
    cls=$(suite_class "$dom"); lane=$cls; pty_lane "$cls" && lane=pty
    budget=$(budget_of "$dom")
    ev launch "$dom" 1 "$lane" "$SLOTS_TOTAL" "$budget" "class=$cls"
    bash scripts/gate/run-suite.sh "$SUITES_DIR/$dom/run-all.sh" "$budget" "$outdir" "$(budget_note "$dom")" || true
    rc=$(read_num "$outdir/$dom.rc" 1); secs=$(read_num "$outdir/$dom.secs" 0); cpu=$(read_num "$outdir/$dom.cpu" 0)
    ev finish "$dom" 1 "$lane" - - "rc=$rc,secs=$secs,cpu=$cpu"
    print_done "$dom" "$outdir"
    [ "$failfast_armed" -eq 1 ] && [ "${#FAIL[@]}" -gt 0 ] && FAILFAST=1
  done
else
  while [ "${#PRINTED[@]}" -lt "$total" ] || [ "${#running_doms[@]}" -gt 0 ] || [ "${#pend_retry[@]}" -gt 0 ]; do
    # ── reap: report each attempt the moment its .rc lands (completion order);
    # a helper that DIED without publishing a result is a RED, never silent.
    if [ "${#running_doms[@]}" -gt 0 ]; then
      keep_doms=(); keep_pids=(); keep_cls=(); keep_wt=(); keep_dir=(); keep_att=()
      i=0
      while [ "$i" -lt "${#running_doms[@]}" ]; do
        dom=${running_doms[$i]}; pid=${running_pids[$i]}; cls=${running_cls[$i]}; wt=${running_wt[$i]}; dir=${running_dir[$i]}; att=${running_att[$i]}
        finished=0
        if [ -f "$dir/$dom.rc" ]; then
          finished=1
        elif ! kill -0 "$pid" 2>/dev/null; then
          sleep 0.2 # grace: .rc may be mid-rename
          if [ ! -f "$dir/$dom.rc" ]; then
            echo "__SUITE_HELPER_DIED without publishing a result__" >>"$dir/$dom.out" 2>/dev/null || true
            echo 1 >"$dir/$dom.rc"
          fi
          finished=1
        fi
        if [ "$finished" -eq 1 ]; then
          wait "$pid" 2>/dev/null
          slots=$(( slots - wt ))
          case "$cls" in (pty) pty_n=$(( pty_n - 1 )) ;; (pure) pure_n=$(( pure_n - 1 )) ;; (exclusive) excl_n=$(( excl_n - 1 )) ;; esac
          finish "$dom" "$cls" "$att" "$dir"
          if [ "$DIST_MUTATED" -eq 0 ] && [ -n "$DIST_STAMP0" ] && [ "$(dist_stamp)" != "$DIST_STAMP0" ]; then
            # the finished suite plus everything still in flight — one of them rebuilt
            DIST_MUTATED=1
            flight=$dom; j=0
            while [ "$j" -lt "${#running_doms[@]}" ]; do
              [ "$j" -ne "$i" ] && flight="$flight,${running_doms[$j]}"
              j=$(( j + 1 ))
            done
            printf '  ⚠  dist/manifest.json CHANGED during the pool (a suite rebuilt dist behind the gate) — suspects: %s\n' "$flight"
            ev distchange - 0 - - - "$flight"
          fi
        else
          keep_doms+=("$dom"); keep_pids+=("$pid"); keep_cls+=("$cls"); keep_wt+=("$wt"); keep_dir+=("$dir"); keep_att+=("$att")
        fi
        i=$(( i + 1 ))
      done
      running_doms=(${keep_doms[@]+"${keep_doms[@]}"}); running_pids=(${keep_pids[@]+"${keep_pids[@]}"})
      running_cls=(${keep_cls[@]+"${keep_cls[@]}"}); running_wt=(${keep_wt[@]+"${keep_wt[@]}"})
      running_dir=(${keep_dir[@]+"${keep_dir[@]}"}); running_att=(${keep_att[@]+"${keep_att[@]}"})
    fi
    [ "$failfast_armed" -eq 1 ] && [ "${#FAIL[@]}" -gt 0 ] && FAILFAST=1
    if [ "$FAILFAST" -eq 1 ] && [ "${#running_doms[@]}" -eq 0 ] && [ "${#pend_retry[@]}" -eq 0 ]; then
      # drain complete — report every never-launched suite LOUDLY, then stop.
      for dom in ${q_pty[@]+"${q_pty[@]}"} ${q_cpu[@]+"${q_cpu[@]}"} ${q_pure[@]+"${q_pure[@]}"} ${q_excl[@]+"${q_excl[@]}"}; do
        if ! was_printed "$dom"; then
          printf '  ⏭  %-18s not launched (fail-fast: an iteration rung stops on RED)\n' "$dom"
        fi
      done
      break
    fi
    # ── dispatch while capacity (never while an exclusive holds the floor) ──
    if [ "$excl_n" -eq 0 ]; then
      while :; do
        # an in-pool re-run rides the HEAD of the pty lane (fail-fast never blocks it)
        if [ "${#pend_retry[@]}" -gt 0 ] && [ "$pty_n" -lt "$PTY_MAX" ] && [ $(( slots + 2 )) -le "$SLOTS_TOTAL" ]; then
          d=${pend_retry[0]}; rest=(); k=1
          while [ "$k" -lt "${#pend_retry[@]}" ]; do rest+=("${pend_retry[$k]}"); k=$(( k + 1 )); done
          pend_retry=(${rest[@]+"${rest[@]}"})
          launch "$d" pty 2 2 "$outdir/retry1"; continue
        fi
        [ "$FAILFAST" -eq 1 ] && break
        if [ "$qi_pty" -lt "$n_pty" ] && [ "$pty_n" -lt "$PTY_MAX" ] && [ $(( slots + 2 )) -le "$SLOTS_TOTAL" ]; then
          d=${q_pty[$qi_pty]}; qi_pty=$(( qi_pty + 1 )); launch "$d" pty 2 1 "$outdir"; continue
        fi
        # cpu before pure for the leftover slots — unless the pure head fits and
        # outlasts the cpu head (longest-first across the two lanes: a long pure
        # suite launched last is the tail of a slot-bound pool)
        if [ "$qi_cpu" -lt "$n_cpu" ] && [ $(( slots + 2 )) -le "$SLOTS_TOTAL" ] && ! pure_head_outlasts_cpu; then
          d=${q_cpu[$qi_cpu]}; qi_cpu=$(( qi_cpu + 1 )); launch "$d" cpu 2 1 "$outdir"; continue
        fi
        if [ "$qi_pure" -lt "$n_pure" ] && [ "$pure_n" -lt "$PURE_MAX" ] && [ $(( slots + 1 )) -le "$SLOTS_TOTAL" ]; then
          d=${q_pure[$qi_pure]}; qi_pure=$(( qi_pure + 1 )); launch "$d" pure 1 1 "$outdir"; continue
        fi
        # exclusive: ALONE — every other queue drained (re-runs included) and the floor empty
        if [ "$qi_excl" -lt "$n_excl" ] && [ "${#running_doms[@]}" -eq 0 ] && [ "${#pend_retry[@]}" -eq 0 ] \
           && [ "$qi_pty" -ge "$n_pty" ] && [ "$qi_cpu" -ge "$n_cpu" ] && [ "$qi_pure" -ge "$n_pure" ]; then
          d=${q_excl[$qi_excl]}; qi_excl=$(( qi_excl + 1 )); launch "$d" exclusive "$SLOTS_TOTAL" 1 "$outdir"
          break
        fi
        # deadlock guard (slot budget < a suite's weight on tiny machines):
        # with an empty floor, always run SOMETHING rather than spin forever.
        if [ "${#running_doms[@]}" -eq 0 ]; then
          if [ "${#pend_retry[@]}" -gt 0 ]; then
            d=${pend_retry[0]}; rest=(); k=1
            while [ "$k" -lt "${#pend_retry[@]}" ]; do rest+=("${pend_retry[$k]}"); k=$(( k + 1 )); done
            pend_retry=(${rest[@]+"${rest[@]}"})
            launch "$d" pty 2 2 "$outdir/retry1"; continue
          fi
          if [ "$qi_pty" -lt "$n_pty" ]; then d=${q_pty[$qi_pty]}; qi_pty=$(( qi_pty + 1 )); launch "$d" pty 2 1 "$outdir"; continue; fi
          if [ "$qi_cpu" -lt "$n_cpu" ]; then d=${q_cpu[$qi_cpu]}; qi_cpu=$(( qi_cpu + 1 )); launch "$d" cpu 2 1 "$outdir"; continue; fi
          if [ "$qi_pure" -lt "$n_pure" ]; then d=${q_pure[$qi_pure]}; qi_pure=$(( qi_pure + 1 )); launch "$d" pure 1 1 "$outdir"; continue; fi
        fi
        break
      done
    fi
    if [ "${#PRINTED[@]}" -lt "$total" ] || [ "${#running_doms[@]}" -gt 0 ] || [ "${#pend_retry[@]}" -gt 0 ]; then sleep 0.3; fi
  done
fi
T_POOL_END=$SECONDS

# ── SOLO re-runs after the drain: the contention-free verdict for a pty-lane
# suite still RED after its pooled attempts (mode escalate: after an in-pool
# re-run; mode after-drain: straight from the pool). One each, recorded.
for dom in ${solo_doms[@]+"${solo_doms[@]}"}; do
  i=$(flk_idx "$dom")
  att=3; [ "$RETRY_MODE" = "after-drain" ] && att=2
  printf '  ⚠  %-18s solo re-run (alone on the floor, recorded, once)…\n' "$dom"
  budget=$(budget_of "$dom")
  ev launch "$dom" "$att" solo "$SLOTS_TOTAL" "$budget" "class=$(suite_class "$dom")"
  bash scripts/gate/run-suite.sh "$SUITES_DIR/$dom/run-all.sh" "$budget" "$outdir/retry2" "$(budget_note "$dom")" >/dev/null 2>&1
  src_=$(read_num "$outdir/retry2/$dom.rc" 1); ssec=$(read_num "$outdir/retry2/$dom.secs" 0); scpu=$(read_num "$outdir/retry2/$dom.cpu" 0)
  ev finish "$dom" "$att" solo - - "rc=$src_,secs=$ssec,cpu=$scpu"
  if [ "$att" -eq 3 ]; then FLK_R2RC[$i]=$src_; FLK_R2SEC[$i]=$ssec; else FLK_R1RC[$i]=$src_; FLK_R1SEC[$i]=$ssec; fi
  if [ "$src_" -eq 0 ]; then
    drop_fail "$dom"; PASS+=("$dom")
    printf '  ✅ %-18s %3ds  (solo re-run GREEN — pool flake RECORDED in the verdict)\n' "$dom" "$ssec"
  else
    printf '  ❌ %-18s %3ds  (solo re-run still RED — genuine)\n' "$dom" "$ssec"
    sed 's/^/      │ /' "$outdir/retry2/$dom.out" 2>/dev/null
  fi
done
T_SOLO_END=$SECONDS

echo "────────────────────────────────────────────"

# ── flake rows (JSON): every attempt, plus the pooled attempt's failure rows
# so a flake stays attributable after the scrollback is gone. soloRc/soloSecs
# carry the FINAL re-run's verdict and timing (the run that decided the row).
FLAKE_ROWS=""
nflk=${#FLK_DOM[@]}
i=0
while [ "$i" -lt "$nflk" ]; do
  dom=${FLK_DOM[$i]}
  retries=""; final_rc=${FLK_PRC[$i]}; final_sec=${FLK_PSEC[$i]}
  if [ "${FLK_R1RC[$i]}" != "-" ]; then
    mode=in-pool; [ "$RETRY_MODE" = "after-drain" ] && mode=after-drain
    retries="$retries{\"mode\": \"$mode\", \"rc\": ${FLK_R1RC[$i]}, \"secs\": ${FLK_R1SEC[$i]}},"
    final_rc=${FLK_R1RC[$i]}; final_sec=${FLK_R1SEC[$i]}
  fi
  if [ "${FLK_R2RC[$i]}" != "-" ]; then
    retries="$retries{\"mode\": \"after-drain\", \"rc\": ${FLK_R2RC[$i]}, \"secs\": ${FLK_R2SEC[$i]}},"
    final_rc=${FLK_R2RC[$i]}; final_sec=${FLK_R2SEC[$i]}
  fi
  fail_rows=$({ grep -nE '\[FAIL\]|FAIL:|✗|❌|FAILED|__SUITE_TIMEOUT|TIMEOUT|error:' "$outdir/$dom.out" 2>/dev/null || true; } | head -8 | cut -c1-160 \
    | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin]))' 2>/dev/null)
  [ -n "$fail_rows" ] || fail_rows='[]'
  FLAKE_ROWS="$FLAKE_ROWS{\"suite\": \"$dom\", \"pooledRc\": ${FLK_PRC[$i]}, \"pooledSecs\": ${FLK_PSEC[$i]}, \"soloRc\": $final_rc, \"soloSecs\": $final_sec, \"retries\": [${retries%,}], \"failRows\": $fail_rows},"
  i=$(( i + 1 ))
done

# ── timeline: the analyzer reads the event log + captured output and leaves
# timeline.json beside it; a full run prints the stopwatch. Best-effort —
# an analyzer failure never recolors the gate.
TIMELINE_JSON=null
WALL_S=$(( SECONDS - T_START ))   # the ONE wall the timeline and the verdict's durationS share
if [ "${#want[@]}" -eq 0 ]; then
  printf '{"cores": %d, "slots": %d, "ptyMax": %d, "pureMax": %d, "sequential": %s, "retryMode": "%s", "budget": {"floorS": %d, "k": %d, "overrideS": %s}, "phases": {"prebuild": "%s", "prebuildS": %d, "poolStartS": %d, "poolEndS": %d, "soloEndS": %d}, "distMutated": %s}\n' \
    "$CORES" "$SLOTS_TOTAL" "$PTY_MAX" "$PURE_MAX" "$([ "$SEQUENTIAL" -eq 1 ] && echo true || echo false)" "$RETRY_MODE" \
    "$BUDGET_FLOOR" "$BUDGET_K" "${BUDGET_OVERRIDE:-null}" \
    "$PREBUILD_KIND" "$PREBUILD_S" "$(( T_POOL0 - T_START ))" "$(( T_POOL_END - T_START ))" "$(( T_SOLO_END - T_START ))" \
    "$([ "$DIST_MUTATED" -eq 1 ] && echo true || echo false)" >"$outdir/pool.json"
  if python3 scripts/gate/timeline.py "$outdir" "$WALL_S" 2>"$outdir/timeline.err"; then
    [ -s "$outdir/timeline.json" ] && TIMELINE_JSON=$(cat "$outdir/timeline.json")
  else
    printf '  ⚠  timeline unavailable: %s\n' "$(tail -1 "$outdir/timeline.err" 2>/dev/null)"
  fi
fi

# Leave a verdict artifact for the /health certificate — BOTH colors,
# best-effort (a write failure never recolors the gate), FULL runs only (a
# subset run proves less than the certificate would claim, so it must not
# overwrite a full verdict). Interpreted by src/utils/healthCertCore.ts:
# green@HEAD+clean ⇒ ok · HEAD moved / dirty ⇒ stale · red ⇒ fail · absent ⇒ unknown.
# rows: "durations" (per-suite pooled seconds — the longest-first
# scheduler's self-refreshing table), "classes", "flakes" (the ledger — a
# pool RED that re-ran, every attempt, the final verdict in soloRc/soloSecs)
# and "timeline" (schema-versioned; scripts/gate/timeline.py).
# Hermetic runs (MERCURY_GATE_SUITES_DIR) never touch the real verdict; their
# provers name an explicit target via MERCURY_GATE_VERDICT_FILE (honored ONLY
# in hermetic mode — a real run redirecting its verdict would silently stale
# the health certificate).
write_verdict=0
if [ "${#want[@]}" -eq 0 ]; then
  if [ "$HERMETIC" -eq 0 ]; then
    write_verdict=1
  elif [ -n "${MERCURY_GATE_VERDICT_FILE:-}" ]; then
    write_verdict=1; VERDICT_FILE="$MERCURY_GATE_VERDICT_FILE"
  fi
fi
if [ "$write_verdict" -eq 1 ]; then
  {
    mkdir -p "$(dirname "$VERDICT_FILE")"
    head_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
    dirty=false
    [ -n "$(git status --porcelain 2>/dev/null | head -c1)" ] && dirty=true
    # CONTENT BINDING (healthCertCore.ts): the tree sha of the tracked working
    # content — a temp index seeded from HEAD, add -A, write-tree. Committing
    # this exact content later keeps the verdict fresh (no stale-after-commit).
    tree_sha=""
    if [ -n "$head_sha" ]; then
      _ti=$(mktemp)
      GIT_INDEX_FILE="$_ti" git read-tree HEAD 2>/dev/null         && GIT_INDEX_FILE="$_ti" git add -A 2>/dev/null         && tree_sha=$(GIT_INDEX_FILE="$_ti" git write-tree 2>/dev/null || echo "")
      rm -f "$_ti"
    fi
    json_list() { local out="" x; for x in "$@"; do out="$out\"$x\","; done; printf '[%s]' "${out%,}"; }
    durations_json=$(
      out=""
      for dom in ${PRINTED[@]+"${PRINTED[@]}"}; do
        s=$(read_num "$outdir/$dom.secs" 0)
        out="$out\"$dom\": $s,"
      done
      printf '{%s}' "${out%,}"
    )
    classes_json=$(
      out=""
      for dom in ${PRINTED[@]+"${PRINTED[@]}"}; do
        out="$out\"$dom\": \"$(suite_class "$dom")\","
      done
      printf '{%s}' "${out%,}"
    )
    printf '{\n  "ok": %s,\n  "pass": %s,\n  "fail": %s,\n  "ranAt": "%s",\n  "headSha": %s,\n  "dirty": %s,\n  "treeSha": %s,\n  "durationS": %d,\n  "durations": %s,\n  "classes": %s,\n  "flakes": [%s],\n  "timeline": %s\n}\n' \
      "$([ "${#FAIL[@]}" -eq 0 ] && echo true || echo false)" \
      "$(json_list ${PASS[@]+"${PASS[@]}"})" \
      "$(json_list ${FAIL[@]+"${FAIL[@]}"})" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$([ -n "$head_sha" ] && printf '"%s"' "$head_sha" || echo null)" \
      "$dirty" \
      "$([ -n "$tree_sha" ] && printf '"%s"' "$tree_sha" || echo null)" \
      "$WALL_S" \
      "$durations_json" \
      "$classes_json" \
      "${FLAKE_ROWS%,}" \
      "$TIMELINE_JSON" > "$VERDICT_FILE.tmp" \
      && mv "$VERDICT_FILE.tmp" "$VERDICT_FILE"
  } 2>/dev/null || true
fi
if [ "$nflk" -gt 0 ]; then
  printf '⚠  %s pool flake row(s) recorded in the verdict ledger\n' "$nflk"
fi
if [ "${#FAIL[@]}" -gt 0 ]; then
  printf '❌ %d/%d RED: %s  ·  %ds total\n' "${#FAIL[@]}" "$total" "${FAIL[*]}" "$(( SECONDS - T_START ))"
  exit 1
fi
printf '✅ ALL %d SUITES GREEN  ·  %ds total\n' "$total" "$(( SECONDS - T_START ))"
