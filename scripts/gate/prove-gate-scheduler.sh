#!/usr/bin/env bash
# ============================================================================
#  prove-gate-scheduler.sh — the class-aware lane scheduler is itself gated
# Exercises scripts/run-all-suites.sh against SYNTHETIC
#  estates via the MERCURY_GATE_SUITES_DIR hermetic seam (no recursion, no
#  real verdict write) with EVERY engine knob pinned explicitly — a prover
#  that inherits ambient env proves the operator's shell, not the engine:
#    1. lane law    — 5 pty-lane suites (incl. one UNDECLARED, scheduled
#                     conservatively) never exceed the PINNED cap 2; the
#                     exclusive suite overlaps NOTHING; everything completes
#                     GREEN; the undeclared suite draws a loud warning.
#    1b. knob law   — MERCURY_GATE_PTY_MAX=3 with ample slots peaks the pty
#                     lane at EXACTLY 3; a set-but-empty env falls back to
#                     the DEFAULT (banner pty≤3) — the default is pinned.
#    1t. timeline   — the verdict's schema-versioned "timeline": every run
#                     inside the wall, phases summing to the wall exactly,
#                     pty occupancy never above the cap at any launch, the
#                     retry ledger agreeing with the flake rows.
#    2. red law     — a RED pure suite turns the gate RED with no re-run.
#    3. flake laws  — escalate (default): an in-pool re-run clears a flake
#                     (2 runs) and starts INSIDE the pool; a twice-RED suite
#                     gets ONE solo re-run after the drain (3 runs); modes
#                     in-pool (exactly 2 runs) and after-drain (the solo
#                     posture, re-run starts after the drain).
#    4. one build   — MERCURY_GATE_BUILD_CMD counts ONE Phase-0 build; suites
#                     see MERCURY_GATE_PREBUILT=1; NO_PREBUILD skips the build
#                     and still marks dist prebuilt; a suite that rebuilds
#                     regardless is the counted defect shape; the dist
#                     tripwire names the suspects of a mid-pool mutation.
#    5. watchdog    — budget = max(floor, 2 × the seed row): a hung suite is
#                     tree-killed at exactly that budget with the rule in its
#                     marker, the budget is recorded per run, an absent row
#                     gets the floor, MERCURY_SUITE_TIMEOUT pins every suite.
#    6. starvation  — a slot budget below 2×cap starves the pty lane while
#                     its queue waits; the timeline reports the seconds.
#    7. fail-fast   — a SUBSET run stops launching on RED (loudly); a FULL
#                     run never fail-fasts.
#    8. sequential  — MERCURY_GATE_JOBS=1 still runs and records a timeline.
#    9. registry    — every REAL scripts/*/run-all.sh declares a valid
#                     `# gate-class:` header; the engine reads its duration
#                     rows from the ONE project store.
#   10. the split   — on the REAL estate, the hosted planner's release plan
#                     (pure · cpu · exclusive) and drives plan (pty), each
#                     over its workflow's matrix, cover every suite exactly
#                     once; gate.yml plans and judges the release scope,
#                     drives.yml the drives scope, neither on push, both on
#                     the same toolchain pins.
#  Bash-3.2 portable (macOS /bin/bash).
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/gate-sched-proof.XXXXXX")
trap 'rm -rf "$work"' EXIT

mk_suite() { # $1=dom  $2=class-header-line (may be empty)  $3=body
  mkdir -p "$work/suites/$1"
  {
    echo '#!/usr/bin/env bash'
    [ -n "$2" ] && echo "$2"
    echo "$3"
  } >"$work/suites/$1/run-all.sh"
}

ts_body() { # $1=dom — record a start/end wall-clock window, hold it 1.2s
  echo "python3 -c 'import time;print(time.time())' >'$work/ts/$1.start'; sleep 1.2; python3 -c 'import time;print(time.time())' >'$work/ts/$1.end'"
}

# The engine under PINNED knobs: every env the engine reads is cleared first,
# then the leg's own pins apply; suite arguments follow `--`.
# Usage: gate <verdict-file> [ENV=val …] [-- suite …]
gate() {
  local verdict=$1; shift
  local pins=() args=() seen=0 a
  for a in "$@"; do
    if [ "$seen" -eq 1 ]; then args+=("$a")
    elif [ "$a" = "--" ]; then seen=1
    else pins+=("$a"); fi
  done
  (
    cd "$repo" && env -u MERCURY_SUITE_TIMEOUT -u MERCURY_SUITE_TIMEOUT_FLOOR -u MERCURY_GATE_RETRY \
      -u MERCURY_GATE_BUILD_CMD -u MERCURY_GATE_NO_PREBUILD -u MERCURY_GATE_SEED_FILE -u MERCURY_GATE_DIST_MANIFEST \
      -u MERCURY_GATE_JOBS -u MERCURY_GATE_PTY_MAX -u MERCURY_GATE_DIST_CACHE -u MERCURY_GATE_PREBUILT \
      MERCURY_GATE_SUITES_DIR="$work/suites" MERCURY_GATE_VERDICT_FILE="$verdict" ${pins[@]+"${pins[@]}"} \
      bash scripts/run-all-suites.sh ${args[@]+"${args[@]}"}
  ) 2>&1
}

mkdir -p "$work/ts"

# --- estate 1: lane law -------------------------------------------------------
for p in p1 p2 p3 p4; do mk_suite "$p" '# gate-class: pty' "$(ts_body "$p")"; done
mk_suite u1 '' "$(ts_body u1)"                      # UNDECLARED → pty lane
for c in c1 c2; do mk_suite "$c" '# gate-class: cpu' "$(ts_body "$c")"; done
for z in z1 z2 z3; do mk_suite "$z" '# gate-class: pure' "$(ts_body "$z")"; done
mk_suite x1 '# gate-class: exclusive' "$(ts_body x1)"

out1=$(gate "$work/verdict1.json" MERCURY_GATE_PTY_MAX=2); rc1=$?
if [ "$rc1" = "0" ] && printf '%s' "$out1" | grep -q 'ALL 11 SUITES GREEN'; then
  echo "  ✓ estate: all 11 synthetic suites GREEN through the lanes"
else
  echo "  ✗ estate run broken (rc=$rc1):"; printf '%s\n' "$out1" | sed 's/^/      /'; fail=1
fi
if printf '%s' "$out1" | grep -q 'u1.*no "# gate-class:" header'; then
  echo "  ✓ undeclared: u1 drew the loud conservative-scheduling warning"
else
  echo "  ✗ undeclared: no warning line for u1"; fail=1
fi
if printf '%s' "$out1" | grep -q '── stopwatch' && printf '%s' "$out1" | grep -q 'critical path (slot handoffs'; then
  echo "  ✓ stopwatch: a full run prints the timeline summary"
else
  echo "  ✗ stopwatch: no timeline summary printed"; fail=1
fi
# Verdict rows: durations for every suite, classes as declared, empty flakes.
python3 - "$work/verdict1.json" <<'PY' || fail=1
import json, sys
v = json.load(open(sys.argv[1]))
d, c, f = v.get('durations') or {}, v.get('classes') or {}, v.get('flakes')
ok = True
if len(d) != 11 or not all(isinstance(x, int) for x in d.values()):
    print(f"  ✗ verdict durations: expected 11 int rows, got {d}"); ok = False
if c.get('p1') != 'pty' or c.get('u1') != 'undeclared' or c.get('x1') != 'exclusive' or c.get('z1') != 'pure':
    print(f"  ✗ verdict classes wrong: {c}"); ok = False
if f != []:
    print(f"  ✗ verdict flakes should be [] on a clean estate: {f}"); ok = False
if ok:
    print("  ✓ verdict rows: 11 duration rows · classes as declared · flakes []")
sys.exit(0 if ok else 1)
PY

# Overlap analysis from the recorded windows.
python3 - "$work/ts" <<'PY'
import sys, os
d = sys.argv[1]
win = {}
for f in os.listdir(d):
    dom, kind = f.rsplit('.', 1)
    win.setdefault(dom, {})[kind] = float(open(os.path.join(d, f)).read().strip())
missing = [k for k, v in win.items() if 'start' not in v or 'end' not in v]
if missing:
    print(f"  ✗ windows missing for: {missing}"); sys.exit(1)

def max_concurrent(doms):
    events = []
    for dom in doms:
        events.append((win[dom]['start'], 1))
        events.append((win[dom]['end'], -1))
    events.sort()
    cur = peak = 0
    for _, delta in events:
        cur += delta
        peak = max(peak, cur)
    return peak

pty = ['p1', 'p2', 'p3', 'p4', 'u1']
peak = max_concurrent(pty)
if peak <= 2:
    print(f"  ✓ pty lane law: peak concurrency {peak} <= 2 across 5 pty-lane suites (cap PINNED 2)")
else:
    print(f"  ✗ pty lane law VIOLATED: peak {peak} > 2 under pinned cap 2"); sys.exit(1)

x = win['x1']
overlaps = [dom for dom in win if dom != 'x1'
            and win[dom]['start'] < x['end'] and win[dom]['end'] > x['start']]
if not overlaps:
    print("  ✓ exclusive law: x1 overlapped nothing")
else:
    print(f"  ✗ exclusive law VIOLATED: x1 overlapped {overlaps}"); sys.exit(1)
PY
[ $? -ne 0 ] && fail=1

# --- estate 1t: the timeline's consistency laws on the same verdict ----------
python3 - "$work/verdict1.json" 2 <<'PY' || fail=1
import json, sys
v = json.load(open(sys.argv[1])); cap = int(sys.argv[2])
t = v.get('timeline')
ok = True
def bad(msg):
    global ok
    ok = False
    print('  ✗ timeline: ' + msg)
if not isinstance(t, dict) or t.get('schema') != 1:
    bad(f'missing or unversioned: {t if not isinstance(t, dict) else t.get("schema")}'); sys.exit(1)
for key in ('phases', 'runs', 'lanes', 'floors', 'criticalPath', 'topWall', 'topProvers', 'retries', 'kills', 'cpu', 'budget'):
    if key not in t:
        bad(f'key {key} absent')
ph = t['phases']; wall = ph['wallS']
if ph['setupS'] + ph['prebuildS'] + ph['poolS'] + ph['soloRetryS'] + ph['tailS'] != wall or min(ph['setupS'], ph['tailS']) < 0:
    bad(f'phases do not sum to the wall: {ph}')
if wall != v['durationS']:
    bad(f"timeline wall {wall} ≠ verdict durationS {v['durationS']}")
runs = t['runs']
if len(runs) != 11 or sorted(r['suite'] for r in runs) != sorted(v['durations']):
    bad(f'expected one run per suite, got {[r["suite"] for r in runs]}')
for r in runs:
    for key in ('suite', 'attempt', 'kind', 'class', 'lane', 'weight', 'budgetS', 'eligibleS', 'startS', 'endS', 'secs', 'queueWaitS', 'cpuS', 'rc'):
        if key not in r:
            bad(f'run {r.get("suite")} lacks {key}')
    if not (0 <= r['startS'] <= r['endS'] <= wall):
        bad(f'run {r["suite"]} offsets outside the wall: {r["startS"]}..{r["endS"]} of {wall}')
    if r['queueWaitS'] != r['startS'] - r['eligibleS'] or r['queueWaitS'] < 0:
        bad(f'run {r["suite"]} queue wait inconsistent: {r}')
    if r['rc'] != 0:
        bad(f'run {r["suite"]} rc {r["rc"]} on a green estate')
pty = [r for r in runs if r['lane'] == 'pty']
if {r['suite'] for r in pty} != {'p1', 'p2', 'p3', 'p4', 'u1'} or any(r['weight'] != 2 for r in pty):
    bad(f'pty lane membership/weight wrong: {[(r["suite"], r["weight"]) for r in pty]}')
for r in pty:   # occupancy at every launch never above the cap
    live = sum(1 for o in pty if o['startS'] <= r['startS'] < o['endS'])
    if live > cap:
        bad(f'{live} pty runs in flight at {r["suite"]}\'s launch (cap {cap})')
lanes = t['lanes']
if not (0 <= lanes['pty']['occupancyPct'] <= 100) or lanes['pty']['cap'] != cap:
    bad(f'pty lane summary wrong: {lanes["pty"]}')
if t['floors']['slotFloorS'] > t['floors']['poolDrainS'] or t['floors']['ptyFloorS'] > t['floors']['poolDrainS']:
    bad(f'a floor exceeds the drain: {t["floors"]}')
cp = t['criticalPath']
if not cp['chain'] or cp['endS'] != max(r['endS'] for r in runs) or cp['chainS'] + cp['gapS'] > wall:
    bad(f'critical path inconsistent: {cp}')
if cp['chain'][-1]['suite'] != 'x1':
    bad(f'the exclusive suite must end the critical path: {cp["chain"][-1]}')
if t['retries'] != {'inPool': 0, 'inPoolGreen': 0, 'inPoolS': 0, 'solo': 0, 'soloGreen': 0, 'soloS': 0} or t['kills'] != []:
    bad(f'retry/kill ledger on a green estate: {t["retries"]} {t["kills"]}')
if t['topWall'][0]['secs'] < 1 or len(t['topWall']) != 10:
    bad(f'topWall wrong: {t["topWall"]}')
if t['budget'] != {'floorS': 600, 'k': 2, 'overrideS': None}:
    bad(f'budget rule not the shipped default: {t["budget"]}')
if ok:
    print('  ✓ timeline: schema 1 · 11 runs inside the wall · phases sum to the wall · pty ≤ cap at every launch · critical path ends on x1')
sys.exit(0 if ok else 1)
PY

# --- estate 1b: the pty-lane cap KNOB ---------
# Same 11-suite estate, slots pinned ample (JOBS=8 ⇒ 16 slots) so the lane cap
# is the ONLY binding constraint: 5 pty-lane suites × 1.2s under cap 3 must
# peak at EXACTLY 3 — <3 means the knob is inert, >3 means the cap broke.
rm -f "$work/ts"/*
out1b=$(gate "$work/verdict1b.json" MERCURY_GATE_JOBS=8 MERCURY_GATE_PTY_MAX=3); rc1b=$?
if [ "$rc1b" = "0" ] && printf '%s' "$out1b" | grep -q 'ALL 11 SUITES GREEN' && printf '%s' "$out1b" | grep -q 'pty≤3'; then
  echo "  ✓ knob estate: 11 suites GREEN under MERCURY_GATE_PTY_MAX=3 (banner shows pty≤3)"
else
  echo "  ✗ knob estate broken (rc=$rc1b):"; printf '%s\n' "$out1b" | sed 's/^/      /'; fail=1
fi
python3 - "$work/ts" <<'PY'
import sys, os
d = sys.argv[1]
win = {}
for f in os.listdir(d):
    dom, kind = f.rsplit('.', 1)
    win.setdefault(dom, {})[kind] = float(open(os.path.join(d, f)).read().strip())
pty = ['p1', 'p2', 'p3', 'p4', 'u1']
missing = [k for k in pty if 'start' not in win.get(k, {}) or 'end' not in win.get(k, {})]
if missing:
    print(f"  ✗ knob windows missing for: {missing}"); sys.exit(1)
events = []
for dom in pty:
    events.append((win[dom]['start'], 1))
    events.append((win[dom]['end'], -1))
events.sort()
cur = peak = 0
for _, delta in events:
    cur += delta
    peak = max(peak, cur)
if peak == 3:
    print("  ✓ pty knob law: peak concurrency EXACTLY 3 under MERCURY_GATE_PTY_MAX=3 (ample slots)")
else:
    print(f"  ✗ pty knob law VIOLATED: peak {peak} != 3 under cap 3"); sys.exit(1)
PY
[ $? -ne 0 ] && fail=1

# Default pin: a SET-BUT-EMPTY env must fall back to the shipped default
# asserted on the banner only.
out1c=$(gate "$work/verdict1c.json" MERCURY_GATE_JOBS=8 MERCURY_GATE_PTY_MAX=); rc1c=$?
if [ "$rc1c" = "0" ] && printf '%s' "$out1c" | grep -q 'pty≤3' && printf '%s' "$out1c" | grep -q 'retry=escalate' && printf '%s' "$out1c" | grep -q 'budget=max(600s, 2×last)'; then
  echo "  ✓ default pins: empty MERCURY_GATE_PTY_MAX ⇒ pty≤3; retry=escalate; budget=max(600s, 2×last) on the banner"
else
  echo "  ✗ default pins broken (rc=$rc1c):"; printf '%s\n' "$out1c" | grep 'running domain' | sed 's/^/      /'; fail=1
fi

# --- estate 2: red law ---------------------------------------------------------
rm -rf "$work/suites"
mk_suite ok '# gate-class: pure' 'exit 0'
mk_suite bad '# gate-class: pure' 'echo synthetic-red >&2; exit 3'
out2=$(gate "$work/verdict2.json"); rc2=$?
if [ "$rc2" != "0" ] && printf '%s' "$out2" | grep -q '1/2 RED: bad'; then
  echo "  ✓ red law: a RED synthetic suite turns the gate RED (rc=$rc2)"
else
  echo "  ✗ red law broken (rc=$rc2):"; printf '%s\n' "$out2" | sed 's/^/      /'; fail=1
fi
if printf '%s' "$out2" | grep -qE 'bad .*re-run'; then
  echo "  ✗ retry scope: a PURE red must NOT get the pty flake re-run"; fail=1
else
  echo "  ✓ retry scope: pure RED failed directly (no re-run line for it)"
fi

# --- estate 3: flake law (escalate) — an in-pool re-run clears a flake, INSIDE the pool
rm -rf "$work/suites"
mk_suite flaky '# gate-class: pty' "echo run >>'$work/flaky.count'; echo '── prove-flake.ts  1s'; sleep 1; if [ -f '$work/flaky.once' ]; then exit 0; else touch '$work/flaky.once'; echo pool-flake >&2; exit 7; fi"
mk_suite steady '# gate-class: pure' 'sleep 6; exit 0'
out3=$(gate "$work/verdict3.json"); rc3=$?
runs3=$(wc -l <"$work/flaky.count" 2>/dev/null | tr -d ' ')
if [ "$rc3" = "0" ] && [ "$runs3" = "2" ] \
   && printf '%s' "$out3" | grep -q 'in-pool re-run queued' \
   && printf '%s' "$out3" | grep -q 'in-pool re-run GREEN' \
   && printf '%s' "$out3" | grep -q '1 pool flake row(s) recorded'; then
  echo "  ✓ flake law: pty pool-RED re-ran in-pool exactly ONCE, recovered GREEN, loudly recorded"
else
  echo "  ✗ flake law broken (rc=$rc3, runs=$runs3):"; printf '%s\n' "$out3" | sed 's/^/      /'; fail=1
fi
python3 - "$work/verdict3.json" <<'PY' || fail=1
import json, sys
v = json.load(open(sys.argv[1]))
f = v.get('flakes') or []
t = v['timeline']
row = f[0] if f else {}
ok = (v.get('ok') is True and len(f) == 1 and row.get('suite') == 'flaky'
      and row.get('pooledRc') == 7 and row.get('soloRc') == 0
      and 'pooledSecs' in row and 'soloSecs' in row
      and row.get('retries') == [{'mode': 'in-pool', 'rc': 0, 'secs': row['soloSecs']}]
      and row.get('failRows') == []
      and 'flaky' in (v.get('pass') or []))
print("  ✓ flake ledger row: pooledRc=7 · retries=[in-pool rc 0] · soloRc=0 carries the final re-run · suite counted PASS" if ok
      else f"  ✗ flake ledger row wrong: ok={v.get('ok')} flakes={f} pass={v.get('pass')}")
retry = [r for r in t['runs'] if r['suite'] == 'flaky' and r['attempt'] == 2]
pool_end = t['phases']['setupS'] + t['phases']['prebuildS'] + t['phases']['poolS']
inside = (len(retry) == 1 and retry[0]['kind'] == 'retry-in-pool' and retry[0]['lane'] == 'pty'
          and retry[0]['startS'] < pool_end - 2 and t['phases']['soloRetryS'] == 0
          and t['retries']['inPool'] == 1 and t['retries']['inPoolGreen'] == 1 and t['retries']['solo'] == 0)
print(f"  ✓ overlap law: the in-pool re-run started at +{retry[0]['startS']}s, inside a {pool_end}s pool — no serialized tail" if inside
      else f"  ✗ overlap law: re-run {retry} pool_end={pool_end} phases={t['phases']} retries={t['retries']}")
prov = t['topProvers']
pok = len(prov) >= 1 and prov[0]['suite'] == 'flaky' and prov[0]['prover'] == 'prove-flake.ts' and prov[0]['secs'] == 1 and t['proverLines'] == 2
print("  ✓ prover attribution: `── prove-flake.ts  1s` parsed from captured output (both attempts, one row)" if pok
      else f"  ✗ prover attribution wrong: {prov} lines={t['proverLines']}")
sys.exit(0 if ok and inside and pok else 1)
PY

# --- estate 4: genuine pty RED (escalate) — in-pool re-run, then ONE solo after the drain, still RED
rm -rf "$work/suites"
mk_suite hopeless '# gate-class: pty' "echo run >>'$work/hopeless.count'; echo genuinely-broken >&2; echo '[FAIL] the leg'; echo '── scripts/hopeless/prove-h.ts  2s'; exit 5"
mk_suite steady '# gate-class: pure' 'sleep 3; exit 0'
out4=$(gate "$work/verdict4.json"); rc4=$?
runs4=$(wc -l <"$work/hopeless.count" 2>/dev/null | tr -d ' ')
if [ "$rc4" != "0" ] && [ "$runs4" = "3" ] && printf '%s' "$out4" | grep -q 'in-pool re-run still RED' \
   && printf '%s' "$out4" | grep -q 'solo re-run still RED — genuine'; then
  echo "  ✓ genuine law: pty RED re-ran in-pool, then solo after the drain (3 runs), stayed RED, gate RED (rc=$rc4)"
else
  echo "  ✗ genuine law broken (rc=$rc4, runs=$runs4):"; printf '%s\n' "$out4" | sed 's/^/      /'; fail=1
fi
python3 - "$work/verdict4.json" <<'PY' || fail=1
import json, sys
v = json.load(open(sys.argv[1]))
f = v.get('flakes') or []
t = v['timeline']
row = f[0] if f else {}
ok = (v.get('ok') is False and len(f) == 1 and row.get('suite') == 'hopeless'
      and row.get('pooledRc') == 5 and row.get('soloRc') == 5
      and [r['mode'] for r in row.get('retries', [])] == ['in-pool', 'after-drain']
      and all(r['rc'] == 5 for r in row['retries'])
      and any('[FAIL] the leg' in line for line in row.get('failRows', []))
      and 'hopeless' in (v.get('fail') or []))
print("  ✓ genuine ledger row: three verdicts RED recorded (pooled, in-pool, after-drain) · failRows name the leg · suite stays FAIL" if ok
      else f"  ✗ genuine ledger row wrong: ok={v.get('ok')} flakes={f} fail={v.get('fail')}")
solo = [r for r in t['runs'] if r['suite'] == 'hopeless' and r['attempt'] == 3]
pool_end = t['phases']['setupS'] + t['phases']['prebuildS'] + t['phases']['poolS']
sok = (len(solo) == 1 and solo[0]['kind'] == 'retry-solo' and solo[0]['lane'] == 'solo'
       and solo[0]['startS'] >= pool_end and t['phases']['soloRetryS'] >= solo[0]['secs']
       and t['retries']['solo'] == 1 and t['retries']['soloGreen'] == 0 and t['retries']['inPool'] == 1)
print(f"  ✓ solo law: the after-drain re-run started at +{solo[0]['startS']}s ≥ pool end {pool_end}s, alone" if sok
      else f"  ✗ solo law: {solo} pool_end={pool_end} retries={t['retries']}")
prov = t['topProvers']
pok = len(prov) == 1 and prov[0] == {'suite': 'hopeless', 'attempt': 1, 'prover': 'prove-h.ts', 'secs': 2}
print("  ✓ prover attribution: the repo-relative path form `── scripts/hopeless/prove-h.ts  2s` is recorded as hopeless/prove-h.ts" if pok
      else f"  ✗ prover attribution (path form) wrong: {prov}")
sys.exit(0 if ok and sok and pok else 1)
PY

# --- estate 3m: the retry MODES ------------------------------------------------
rm -rf "$work/suites"; rm -f "$work/flaky.once" "$work/flaky.count"
mk_suite flaky '# gate-class: pty' "echo run >>'$work/flaky.count'; if [ -f '$work/flaky.once' ]; then exit 0; else touch '$work/flaky.once'; exit 7; fi"
mk_suite steady '# gate-class: pure' 'sleep 3; exit 0'
out3a=$(gate "$work/verdict3a.json" MERCURY_GATE_RETRY=after-drain); rc3a=$?
runs3a=$(wc -l <"$work/flaky.count" 2>/dev/null | tr -d ' ')
python3 - "$work/verdict3a.json" "$rc3a" "$runs3a" <<'PY' || { fail=1; printf '%s\n' "$out3a" | sed 's/^/      /'; }
import json, sys
v = json.load(open(sys.argv[1])); rc = sys.argv[2]; runs = sys.argv[3]
t = v['timeline']; row = (v.get('flakes') or [{}])[0]
retry = [r for r in t['runs'] if r['suite'] == 'flaky' and r['attempt'] == 2]
pool_end = t['phases']['setupS'] + t['phases']['prebuildS'] + t['phases']['poolS']
ok = (rc == '0' and runs == '2' and row.get('retries') == [{'mode': 'after-drain', 'rc': 0, 'secs': row.get('soloSecs')}]
      and len(retry) == 1 and retry[0]['kind'] == 'retry-solo' and retry[0]['startS'] >= pool_end
      and t['retryMode'] == 'after-drain' and t['retries']['inPool'] == 0 and t['retries']['solo'] == 1)
print(f"  ✓ mode after-drain: ONE solo re-run after the drain (+{retry[0]['startS']}s ≥ {pool_end}s), recorded as after-drain" if ok
      else f"  ✗ mode after-drain broken: rc={rc} runs={runs} row={row} retry={retry} pool_end={pool_end}")
sys.exit(0 if ok else 1)
PY
rm -rf "$work/suites"; rm -f "$work/hopeless.count"
mk_suite hopeless '# gate-class: pty' "echo run >>'$work/hopeless.count'; exit 5"
mk_suite steady '# gate-class: pure' 'sleep 2; exit 0'
out3b=$(gate "$work/verdict3b.json" MERCURY_GATE_RETRY=in-pool); rc3b=$?
runs3b=$(wc -l <"$work/hopeless.count" 2>/dev/null | tr -d ' ')
if [ "$rc3b" != "0" ] && [ "$runs3b" = "2" ] && printf '%s' "$out3b" | grep -q 'in-pool re-run still RED — genuine' \
   && ! printf '%s' "$out3b" | grep -qE 'solo re-run (GREEN|still|\(alone)'; then
  echo "  ✓ mode in-pool: exactly ONE in-pool re-run, no solo escalation, gate RED (rc=$rc3b)"
else
  echo "  ✗ mode in-pool broken (rc=$rc3b, runs=$runs3b):"; printf '%s\n' "$out3b" | sed 's/^/      /'; fail=1
fi
out3c=$(gate "$work/verdict3c.json" MERCURY_GATE_RETRY=bogus); rc3c=$?
if printf '%s' "$out3c" | grep -q 'retry=escalate'; then
  echo "  ✓ mode pin: an unknown MERCURY_GATE_RETRY falls back to escalate (banner)"
else
  echo "  ✗ mode pin broken:"; printf '%s\n' "$out3c" | grep 'running domain' | sed 's/^/      /'; fail=1
fi

# --- estate 6: ONE BUILD per pool ---------------------------------------------
# A counting build stub stands in for `bun run build.ts`; three suites honour
# MERCURY_GATE_PREBUILT the way the real ones do (identity, reliability); the
# pool performs exactly ONE build and every suite sees the prebuilt mark.
rm -rf "$work/suites"; rm -f "$work/build.count" "$work/saw.prebuilt"
printf '#!/usr/bin/env bash\necho build >>"%s"\nexit 0\n' "$work/build.count" >"$work/build-stub.sh"; chmod +x "$work/build-stub.sh"
honours="if [ \"\${MERCURY_GATE_PREBUILT:-0}\" = 1 ]; then echo prebuilt >>'$work/saw.prebuilt'; else bash '$work/build-stub.sh'; fi; exit 0"
for s in b1 b2 b3; do mk_suite "$s" '# gate-class: cpu' "$honours"; done
out6=$(gate "$work/verdict6.json" MERCURY_GATE_BUILD_CMD="bash $work/build-stub.sh"); rc6=$?
builds6=$(wc -l <"$work/build.count" 2>/dev/null | tr -d ' '); saw6=$(wc -l <"$work/saw.prebuilt" 2>/dev/null | tr -d ' ')
pre6=$(python3 -c "import json,sys; t=json.load(open(sys.argv[1]))['timeline']; print(t['phases']['prebuild'], t['phases']['prebuildS'] >= 0)" "$work/verdict6.json" 2>/dev/null)
if [ "$rc6" = "0" ] && [ "$builds6" = "1" ] && [ "$saw6" = "3" ] && [ "$pre6" = "built True" ] && printf '%s' "$out6" | grep -q 'prebuild dist'; then
  echo "  ✓ one-build law: Phase 0 built ONCE (count 1), all 3 suites saw MERCURY_GATE_PREBUILT=1, phase recorded as built"
else
  echo "  ✗ one-build law broken (rc=$rc6, builds=$builds6, saw=$saw6, phase='$pre6'):"; printf '%s\n' "$out6" | sed 's/^/      /'; fail=1
fi
rm -f "$work/build.count" "$work/saw.prebuilt"
out6b=$(gate "$work/verdict6b.json" MERCURY_GATE_BUILD_CMD="bash $work/build-stub.sh" MERCURY_GATE_NO_PREBUILD=1); rc6b=$?
builds6b=0; [ -f "$work/build.count" ] && builds6b=$(wc -l <"$work/build.count" | tr -d ' ')
saw6b=$(wc -l <"$work/saw.prebuilt" 2>/dev/null | tr -d ' ')
pre6b=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['timeline']['phases']['prebuild'])" "$work/verdict6b.json" 2>/dev/null)
if [ "$rc6b" = "0" ] && [ "${builds6b:-0}" = "0" ] && [ "$saw6b" = "3" ] && [ "$pre6b" = "skipped" ]; then
  echo "  ✓ no-prebuild law: MERCURY_GATE_NO_PREBUILD=1 builds NOTHING and still marks dist prebuilt for every suite (phase skipped)"
else
  echo "  ✗ no-prebuild law broken (rc=$rc6b, builds=${builds6b:-0}, saw=$saw6b, phase='$pre6b')"; fail=1
fi
# The defect shape: a suite that rebuilds REGARDLESS of the mark is counted —
# the stub discriminates, so a real suite's build line can be audited by it.
rm -f "$work/build.count" "$work/saw.prebuilt"
mk_suite b4 '# gate-class: cpu' "bash '$work/build-stub.sh'; exit 0"
out6c=$(gate "$work/verdict6c.json" MERCURY_GATE_BUILD_CMD="bash $work/build-stub.sh"); rc6c=$?
builds6c=$(wc -l <"$work/build.count" 2>/dev/null | tr -d ' ')
if [ "$rc6c" = "0" ] && [ "$builds6c" = "2" ]; then
  echo "  ✓ defect shape: a suite that rebuilds regardless of the mark is COUNTED (2 builds, not 1)"
else
  echo "  ✗ defect shape not discriminated (rc=$rc6c, builds=$builds6c)"; fail=1
fi
# The dist tripwire: a suite that touches the watched manifest mid-pool is named.
rm -rf "$work/suites"
printf '{"buildTree":"x"}\n' >"$work/manifest.json"
mk_suite mutator '# gate-class: cpu' "sleep 1; touch -t 203001010000 '$work/manifest.json'; sleep 1; exit 0"
mk_suite bystander '# gate-class: pure' 'sleep 3; exit 0'
out6d=$(gate "$work/verdict6d.json" MERCURY_GATE_DIST_MANIFEST="$work/manifest.json"); rc6d=$?
python3 - "$work/verdict6d.json" "$rc6d" <<'PY' || { fail=1; printf '%s\n' "$out6d" | sed 's/^/      /'; }
import json, sys
v = json.load(open(sys.argv[1])); t = v['timeline']; m = t.get('distMutated')
ok = (sys.argv[2] == '0' and isinstance(m, dict) and 'mutator' in m.get('suspects', []) and m.get('atS', -1) >= 0)
print(f"  ✓ dist tripwire: the mid-pool manifest change is recorded at +{m['atS']}s with suspects {m['suspects']}" if ok
      else f"  ✗ dist tripwire: rc={sys.argv[2]} distMutated={m}")
sys.exit(0 if ok else 1)
PY
if printf '%s' "$out6d" | grep -q 'CHANGED during the pool'; then
  echo "  ✓ dist tripwire: the loud line printed"
else
  echo "  ✗ dist tripwire: no loud line"; fail=1
fi

# --- estate 7: the WATCHDOG budget rule ---------------------------------------
# Seed rows through the hermetic seed seam, the floor pinned to 1 s:
#   hang   seed 2 ⇒ budget max(1, 2×2) = 4 s — sleeps 30, tree-killed at 4
#   grown  seed 1 ⇒ budget 2 s — sleeps 1.2 (grew past its row, under 2×) and lives
#   newcomer (no row) ⇒ the floor — exits at once
rm -rf "$work/suites"
printf 'hang\t2\ngrown\t1\ncamelCase\t3\n' >"$work/seed.tsv"
mk_suite hang '# gate-class: pure' "sleep 30 & echo \$! >'$work/hang-child.pid'; wait"
mk_suite grown '# gate-class: pure' 'sleep 1.2; exit 0'
mk_suite newcomer '# gate-class: pure' 'exit 0'
mk_suite camelCase '# gate-class: pure' 'exit 0'   # a mixed-case name reads its row (turnEngine, sessionStorage)
t7=$SECONDS
out7=$(gate "$work/verdict7.json" MERCURY_GATE_SEED_FILE="$work/seed.tsv" MERCURY_SUITE_TIMEOUT_FLOOR=1); rc7=$?
dt7=$(( SECONDS - t7 ))
child7=$(cat "$work/hang-child.pid" 2>/dev/null || echo "")
[ -n "$child7" ] && kill -9 "$child7" 2>/dev/null
python3 - "$work/verdict7.json" "$rc7" "$dt7" <<'PY' || { fail=1; printf '%s\n' "$out7" | sed 's/^/      /'; }
import json, sys
v = json.load(open(sys.argv[1])); rc = sys.argv[2]; dt = int(sys.argv[3])
t = v['timeline']; runs = {r['suite']: r for r in t['runs']}
ok = True
def bad(msg):
    global ok
    ok = False
    print('  ✗ watchdog: ' + msg)
if rc == '0' or v['fail'] != ['hang'] or sorted(v['pass']) != ['camelCase', 'grown', 'newcomer']:
    bad(f"verdict: rc={rc} pass={v['pass']} fail={v['fail']}")
if runs['hang']['budgetS'] != 4 or runs['hang']['rc'] != 137:
    bad(f"hang budget/rc: {runs['hang']}")
if runs['camelCase']['budgetS'] != 6:
    bad(f"a mixed-case suite must read its seed row (3 ⇒ budget 6): {runs['camelCase']}")
if not (3 <= runs['hang']['secs'] <= 6):
    bad(f"hang was not killed at its 4 s budget: {runs['hang']['secs']}s")
if runs['grown']['budgetS'] != 2 or runs['grown']['rc'] != 0:
    bad(f"grown (seed 1, ran 1.2) must survive under budget 2: {runs['grown']}")
if runs['newcomer']['budgetS'] != 1 or runs['newcomer']['rc'] != 0:
    bad(f"newcomer (no row) must get the 1 s floor: {runs['newcomer']}")
if t['kills'] != [{'suite': 'hang', 'attempt': 1, 'budgetS': 4, 'secs': runs['hang']['secs']}]:
    bad(f"kills ledger: {t['kills']}")
if t['budget'] != {'floorS': 1, 'k': 2, 'overrideS': None}:
    bad(f"budget rule recorded wrong: {t['budget']}")
if dt > 20:
    bad(f'the estate took {dt}s — a kill at 4 s cannot take that long')
if ok:
    print(f"  ✓ watchdog rule: hang (seed 2) tree-killed at budget 4 s (ran {runs['hang']['secs']}s, rc 137) · grown (seed 1) lived under 2 s · newcomer got the floor · kills ledger + budgets recorded")
sys.exit(0 if ok else 1)
PY
if printf '%s' "$out7" | grep -q '__SUITE_TIMEOUT after 4s (tree-killed; budget = max(1 s floor, 2 × 2 s last pooled)'; then
  echo "  ✓ watchdog marker: the kill line carries the rule (floor, K, last pooled seconds)"
else
  echo "  ✗ watchdog marker: rule text missing from the timeout marker"; printf '%s\n' "$out7" | grep -i timeout | sed 's/^/      /'; fail=1
fi
# The operator's override pins EVERY suite to that many seconds.
rm -f "$work/hang-child.pid"
t7b=$SECONDS
out7b=$(gate "$work/verdict7b.json" MERCURY_GATE_SEED_FILE="$work/seed.tsv" MERCURY_SUITE_TIMEOUT=2); rc7b=$?
dt7b=$(( SECONDS - t7b ))
child7b=$(cat "$work/hang-child.pid" 2>/dev/null || echo "")
[ -n "$child7b" ] && kill -9 "$child7b" 2>/dev/null
python3 - "$work/verdict7b.json" "$rc7b" <<'PY' || { fail=1; printf '%s\n' "$out7b" | sed 's/^/      /'; }
import json, sys
v = json.load(open(sys.argv[1])); t = v['timeline']; runs = {r['suite']: r for r in t['runs']}
ok = (sys.argv[2] != '0' and all(r['budgetS'] == 2 for r in runs.values()) and runs['hang']['rc'] == 137
      and t['budget'] == {'floorS': 600, 'k': 2, 'overrideS': 2} and v['fail'] == ['hang'])
print("  ✓ watchdog override: MERCURY_SUITE_TIMEOUT=2 pins every suite's budget to 2 s (recorded as the override)" if ok
      else f"  ✗ watchdog override wrong: budgets={[(k, r['budgetS'], r['rc']) for k, r in runs.items()]} rule={t['budget']}")
sys.exit(0 if ok else 1)
PY
if printf '%s' "$out7b" | grep -q 'budget=2s pinned'; then
  echo "  ✓ watchdog banner: the override shows as pinned"
else
  echo "  ✗ watchdog banner: override not on the banner"; fail=1
fi

# --- estate 8: STARVATION is reported with its seconds ------------------------
# JOBS=2 ⇒ 4 slots under cap 3: two pty suites fill the budget, the third
# waits ~2 s with the lane under its cap — starvation by the slot budget.
rm -rf "$work/suites"
for p in s1 s2 s3; do mk_suite "$p" '# gate-class: pty' 'sleep 2; exit 0'; done
out8=$(gate "$work/verdict8.json" MERCURY_GATE_JOBS=2 MERCURY_GATE_PTY_MAX=3); rc8=$?
python3 - "$work/verdict8.json" "$rc8" <<'PY' || { fail=1; printf '%s\n' "$out8" | sed 's/^/      /'; }
import json, sys
v = json.load(open(sys.argv[1])); t = v['timeline']; pty = t['lanes']['pty']
third = max(t['runs'], key=lambda r: r['startS'])
ok = (sys.argv[2] == '0' and t['slots'] == 4 and pty['cap'] == 3 and 1 <= pty['starvedS'] <= 3
      and pty['starvedByNonPtyS'] == 0 and third['queueWaitS'] >= 1 and third['queueWaitS'] == pty['starvedS'])
print(f"  ✓ starvation law: the third pty suite waited {third['queueWaitS']}s under cap 3 on 4 slots — reported as starved {pty['starvedS']}s (none of it held by cpu/pure work)" if ok
      else f"  ✗ starvation law: rc={sys.argv[2]} slots={t['slots']} pty={pty} third={third}")
sys.exit(0 if ok else 1)
PY
if printf '%s' "$out8" | grep -qE 'starved [1-3]s'; then
  echo "  ✓ starvation line: the stopwatch prints the starved seconds"
else
  echo "  ✗ starvation line missing from the stopwatch"; printf '%s\n' "$out8" | grep 'slots' | sed 's/^/      /'; fail=1
fi

# --- estate 8b: longest-first ACROSS the cpu and pure lanes --------------------
# 4 slots: p (pty, seed 1) holds 2; the leftover 2 go to whichever head runs
# longer — z (pure, seed 3) before c (cpu, seed 2). z launches at t0 beside p,
# c follows once p frees its slots; cpu-first would park z behind c.
rm -rf "$work/suites"
printf 'p\t1\nc\t2\nz\t3\n' >"$work/seed8b.tsv"
mk_suite p '# gate-class: pty' 'sleep 1; exit 0'
mk_suite c '# gate-class: cpu' 'sleep 2; exit 0'
mk_suite z '# gate-class: pure' 'sleep 3; exit 0'
out8b=$(gate "$work/verdict8b.json" MERCURY_GATE_JOBS=2 MERCURY_GATE_SEED_FILE="$work/seed8b.tsv"); rc8b=$?
python3 - "$work/verdict8b.json" "$rc8b" <<'PY' || { fail=1; printf '%s\n' "$out8b" | sed 's/^/      /'; }
import json, sys
v = json.load(open(sys.argv[1])); t = v['timeline']; runs = {r['suite']: r for r in t['runs']}
# ORDER-RELATIVE (gate run 3, hosted 2-core): launch latency put wave 1 at
# +1s absolute, so startS==0 pinned hardware, not law. The law is the ORDER:
# z rides wave 1 beside p (within 1 s jitter), strictly before c (cpu-first
# would park z behind c), and c joins while z still runs.
ok = (sys.argv[2] == '0'
      and abs(runs['z']['startS'] - runs['p']['startS']) <= 1
      and runs['z']['startS'] < runs['c']['startS']
      and runs['c']['startS'] < runs['z']['endS'])
print(f"  ✓ cross-lane law: the longer pure head (z) launched in wave 1 beside the pty suite; the cpu head (c) followed at +{runs['c']['startS']}s" if ok
      else f"  ✗ cross-lane law: rc={sys.argv[2]} runs={[(k, r['startS'], r['endS']) for k, r in runs.items()]}")
sys.exit(0 if ok else 1)
PY

# --- estate 5: fail-fast is an ITERATION-RUNG behavior (subset runs only) -----
# Tie-order note: equal seed durations sort by full-line byte order REVERSED
# (sort -rn), so 'zz-red' launches in and exits RED before the 4s
# suites finish — at least one 'aa-s*' must then be reported NOT LAUNCHED.
rm -rf "$work/suites"
mk_suite zz-red '# gate-class: cpu' 'sleep 0.3; echo subset-red >&2; exit 4'
for s in aa-s1 aa-s2 aa-s3; do mk_suite "$s" '# gate-class: cpu' 'sleep 4; exit 0'; done
out5=$(gate "$work/verdict5.json" MERCURY_GATE_JOBS=2 -- zz-red aa-s1 aa-s2 aa-s3 2>&1); rc5=$?
if [ "$rc5" != "0" ] && printf '%s' "$out5" | grep -q 'not launched (fail-fast'; then
  echo "  ✓ fail-fast law: a SUBSET run stopped launching on RED, skips reported loudly (rc=$rc5)"
else
  echo "  ✗ fail-fast law broken (rc=$rc5):"; printf '%s\n' "$out5" | sed 's/^/      /'; fail=1
fi
if [ -e "$work/verdict5.json" ]; then
  echo "  ✗ subset law: a subset run must not write a verdict"; fail=1
else
  echo "  ✓ subset law: the subset run wrote no verdict"
fi
# A FULL run must NEVER fail-fast: same estate, no args ⇒ all 4 report.
out6=$(gate "$work/verdict5b.json" MERCURY_GATE_JOBS=2); rc6=$?
n_done=$(printf '%s\n' "$out6" | grep -cE '  (✅|❌) (zz-red|aa-s[123])')
if [ "$rc6" != "0" ] && [ "$n_done" = "4" ] && ! printf '%s' "$out6" | grep -q 'not launched'; then
  echo "  ✓ full-coverage law: a FULL run reports every suite despite the RED (4/4, no skips)"
else
  echo "  ✗ full-coverage law broken (rc=$rc6, reported=$n_done):"; printf '%s\n' "$out6" | sed 's/^/      /'; fail=1
fi

# --- estate 9: SEQUENTIAL still runs and records a timeline --------------------
rm -rf "$work/suites"
mk_suite q1 '# gate-class: pty' 'exit 0'
mk_suite q2 '# gate-class: pure' 'exit 0'
out9=$(gate "$work/verdict9.json" MERCURY_GATE_JOBS=1); rc9=$?
seq9=$(python3 -c "import json,sys; t=json.load(open(sys.argv[1]))['timeline']; print(t['sequential'], len(t['runs']))" "$work/verdict9.json" 2>/dev/null)
if [ "$rc9" = "0" ] && [ "$seq9" = "True 2" ] && printf '%s' "$out9" | grep -q 'SEQUENTIAL'; then
  echo "  ✓ sequential law: MERCURY_GATE_JOBS=1 runs every suite in turn and records a 2-run timeline"
else
  echo "  ✗ sequential law broken (rc=$rc9, timeline='$seq9')"; fail=1
fi

# --- 10: registry — every REAL suite declares a valid class ------------------
undeclared=""
for runner in "$repo"/scripts/*/run-all.sh; do
  [ -e "$runner" ] || continue
  dom=$(basename "$(dirname "$runner")")
  cls=$(sed -n 's/^# gate-class:[[:space:]]*//p' "$runner" | head -1 | tr -d '[:space:]')
  case "$cls" in (pure | cpu | pty | exclusive) : ;; (*) undeclared="$undeclared $dom" ;; esac
done
if [ -z "$undeclared" ]; then
  echo "  ✓ registry: every real suite declares a valid # gate-class header"
else
  echo "  ✗ registry: undeclared suite(s):$undeclared — add '# gate-class: pure|cpu|pty|exclusive'"
  fail=1
fi
# The seed carries a row for every real suite (a renamed suite keeps its
# measured seconds; a missing row schedules at the 30 s default and budgets
# at the floor).
unseeded=""
for runner in "$repo"/scripts/*/run-all.sh; do
  dom=$(basename "$(dirname "$runner")")
  grep -q "^$dom	[0-9][0-9]*$" "$repo/scripts/gate/duration-seed.tsv" || unseeded="$unseeded $dom"
done
if [ -z "$unseeded" ]; then
  echo "  ✓ seed: every real suite has a duration row in scripts/gate/duration-seed.tsv"
else
  echo "  ✗ seed: suite(s) without a duration row:$unseeded"; fail=1
fi
# --- 10: THE SPLIT on the real estate — one planner, two plans, every suite once
gate_yml="$repo/.github/workflows/gate.yml"; drives_yml="$repo/.github/workflows/drives.yml"
rel_n=$(grep -oE 'ci-shard\.sh "\$\{\{ matrix\.shard \}\}" [0-9]+ --class release' "$gate_yml" | grep -oE '[0-9]+ --class' | grep -oE '[0-9]+' | head -1)
drv_n=$(grep -oE 'ci-shard\.sh "\$\{\{ matrix\.shard \}\}" [0-9]+ --class drives' "$drives_yml" | grep -oE '[0-9]+ --class' | grep -oE '[0-9]+' | head -1)
plan_all() { # $1=class $2=shard-count → every suite that plan holds (every shard + the darwin lane)
  local i=0
  while [ "$i" -lt "$2" ]; do
    (cd "$repo" && bash scripts/gate/ci-shard.sh "$i" "$2" --class "$1" --plan-only 2>/dev/null)
    i=$(( i + 1 ))
  done
  (cd "$repo" && bash scripts/gate/ci-shard.sh darwin "$2" --class "$1" --plan-only 2>/dev/null)
}
if [ -n "$rel_n" ] && [ -n "$drv_n" ]; then
  rel_plan=$(plan_all release "$rel_n" | sort)
  drv_plan=$(plan_all drives "$drv_n" | sort)
  estate=$(for runner in "$repo"/scripts/*/run-all.sh; do basename "$(dirname "$runner")"; done | sort)
  both=$(printf '%s\n%s\n' "$rel_plan" "$drv_plan" | grep . | sort)
  if [ "$both" = "$estate" ]; then
    echo "  ✓ split coverage: the release plan ($(printf '%s\n' "$rel_plan" | grep -c .) suites over $rel_n shards) and the drives plan ($(printf '%s\n' "$drv_plan" | grep -c .) over $drv_n) cover every real suite exactly once"
  else
    echo "  ✗ split coverage: suites outside the two plans, or in both:"
    printf '%s\n%s\n' "$both" "$estate" | grep . | sort | uniq -u | sed 's/^/      /'; fail=1
  fi
  misplanned=""
  for dom in $rel_plan; do
    case "$(sed -n 's/^# gate-class:[[:space:]]*//p' "$repo/scripts/$dom/run-all.sh" | head -1 | tr -d '[:space:]')" in (pure | cpu | exclusive) ;; (*) misplanned="$misplanned $dom" ;; esac
  done
  for dom in $drv_plan; do
    case "$(sed -n 's/^# gate-class:[[:space:]]*//p' "$repo/scripts/$dom/run-all.sh" | head -1 | tr -d '[:space:]')" in (pty) ;; (*) misplanned="$misplanned $dom" ;; esac
  done
  if [ -z "$misplanned" ]; then
    echo "  ✓ split classes: no pty suite in the release plan; only pty suites in the drives plan"
  else
    echo "  ✗ split classes: misplanned:$misplanned"; fail=1
  fi
else
  echo "  ✗ workflows: the shard step's matrix size and class could not be read (gate.yml: '$rel_n', drives.yml: '$drv_n')"; fail=1
fi
# The workflow text: each plans by its class and judges by its scope; neither runs on push; the toolchain pins agree.
if grep -q "ci-shard.sh darwin $rel_n --class release" "$gate_yml" && grep -q -- '--scope release' "$gate_yml" \
   && grep -q 'name: gate-verdict' "$gate_yml" && grep -q 'workflow_dispatch:' "$gate_yml" && ! grep -qE '^  push:' "$gate_yml"; then
  echo "  ✓ gate.yml: plans the release class (shards + darwin), judges the release scope, keeps the gate-verdict artifact, dispatch-only"
else
  echo "  ✗ gate.yml: release class/scope/artifact/trigger pins broken"; fail=1
fi
if grep -q "ci-shard.sh darwin $drv_n --class drives" "$drives_yml" && grep -q -- '--scope drives' "$drives_yml" \
   && grep -q 'name: drives-verdict' "$drives_yml" && grep -q 'workflow_dispatch:' "$drives_yml" && grep -q 'schedule:' "$drives_yml" \
   && ! grep -qE '^  push:' "$drives_yml"; then
  echo "  ✓ drives.yml: plans the drives class (shards + darwin), judges the drives scope, writes drives-verdict, manual + schedule, never on push"
else
  echo "  ✗ drives.yml: drives class/scope/artifact/trigger pins broken"; fail=1
fi
gate_bun=$(grep -o 'bun-version: [0-9.]*' "$gate_yml" | sort -u | paste -sd' ' -)
drv_bun=$(grep -o 'bun-version: [0-9.]*' "$drives_yml" | sort -u | paste -sd' ' -)
if [ -n "$gate_bun" ] && [ "$gate_bun" = "$drv_bun" ] && [ "$(grep -c 'node-version-file: .node-version' "$drives_yml")" = "3" ]; then
  echo "  ✓ toolchain: both workflows pin the same bun ($gate_bun); drives.yml selects the calibration Node in build, shard and darwin"
else
  echo "  ✗ toolchain: gate '$gate_bun' vs drives '$drv_bun'; drives node-version-file uses: $(grep -c 'node-version-file: .node-version' "$drives_yml")"; fail=1
fi
# The engine reads the verdict from the ONE project store.
if grep -q '\.claude/gate' "$repo/scripts/run-all-suites.sh"; then
  echo "  ✗ store: the engine still names the retired .claude/gate verdict path"; fail=1
else
  echo "  ✓ store: the engine reads its duration rows from the project store only"
fi

exit "$fail"
