#!/usr/bin/env bash
# ============================================================================
#  prove-gate-runner.sh — the gate's own execution unit is itself gated.
#
#  Exercises scripts/gate/run-suite.sh against SYNTHETIC suites (never the real
#  ones — no recursion):
#    1. green suite   → rc file "0", helper exits 0, output captured
#    2. red suite     → rc file "3" propagated, helper exits 3
#    3. hanging suite → watchdog fires: helper exits nonzero, __SUITE_TIMEOUT
#                       marker in .out, and the suite's CHILD process is
#                       tree-killed (the whole point of kill_tree — a hung
#                       PTY/child must not outlive its suite).
#  Bash-3.2 portable (macOS /bin/bash). Fast: the timeout case uses 1s.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
helper="$here/run-suite.sh"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/gate-runner-proof.XXXXXX")
trap 'rm -rf "$work"' EXIT

mk_suite() { # $1=name  $2=body
  mkdir -p "$work/$1"
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"$work/$1/run-all.sh"
}

out="$work/out"; mkdir -p "$out"

# --- 1: green ---------------------------------------------------------------
mk_suite green 'echo hello-from-green; exit 0'
if bash "$helper" "$work/green/run-all.sh" 30 "$out" \
   && [ "$(cat "$out/green.rc")" = "0" ] \
   && grep -q hello-from-green "$out/green.out"; then
  echo "  ✓ green: rc 0 propagated, output captured"
else
  echo "  ✗ green case broken"; fail=1
fi

# --- 2: red rc propagation ---------------------------------------------------
mk_suite red 'echo boom >&2; exit 3'
bash "$helper" "$work/red/run-all.sh" 30 "$out"; rc=$?
if [ "$rc" = "3" ] && [ "$(cat "$out/red.rc")" = "3" ] && grep -q boom "$out/red.out" && [ ! -f "$out/red.hang" ]; then
  echo "  ✓ red: rc 3 propagated (helper + rc file), stderr captured, no hang sidecar"
else
  echo "  ✗ red case broken (helper rc=$rc, file=$(cat "$out/red.rc" 2>/dev/null))"; fail=1
fi

# --- 3: hang → watchdog tree-kill ---------------------------------------------
mk_suite hang "sleep 600 & echo \$! >'$work/hang-child.pid'; wait"
bash "$helper" "$work/hang/run-all.sh" 1 "$out"; rc=$?
child=$(cat "$work/hang-child.pid" 2>/dev/null || echo "")
dead=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -z "$child" ] || ! kill -0 "$child" 2>/dev/null; then dead=1; break; fi
  sleep 0.3
done
if [ "$rc" != "0" ] && grep -q __SUITE_TIMEOUT "$out/hang.out" && [ -f "$out/hang.hang" ] && [ "$dead" = "1" ]; then
  echo "  ✓ hang: watchdog fired (rc=$rc), marker written, sidecar witnessed, child tree-killed"
else
  echo "  ✗ hang case broken (rc=$rc, sidecar=$([ -f "$out/hang.hang" ] && echo yes || echo no), child-dead=$dead)"; fail=1
  [ -n "$child" ] && kill -9 "$child" 2>/dev/null
fi

# --- 4: forking suite → zero survivors (enumerate-window escape regression) --
# A suite that forks every ~10ms exercises the kill_tree TOCTOU: with the old
# enumerate-then-kill walk, a child spawned into the pgrep→kill window escaped
# the reap. Freeze-then-reap (kill -STOP before enumerating) makes escape
# impossible by construction; this leg pins that: after the watchdog fires,
# EVERY child the suite ever spawned must be dead.
mk_suite forker "while :; do sleep 30 & echo \$! >>'$work/forker-kids.pids'; sleep 0.01; done"
bash "$helper" "$work/forker/run-all.sh" 1 "$out" >/dev/null 2>&1
sleep 0.5
survivors=""
spawned=0
while read -r kp || [ -n "$kp" ]; do
  [ -n "$kp" ] || continue
  spawned=$(( spawned + 1 ))
  kill -0 "$kp" 2>/dev/null && survivors="$survivors $kp"
done <"$work/forker-kids.pids"
if [ -z "$survivors" ] && [ "$spawned" -gt 5 ]; then
  echo "  ✓ forker: tree-kill left zero survivors ($spawned children spawned)"
else
  echo "  ✗ forker: escaped children:${survivors:- none-spawned (spawned=$spawned)}"; fail=1
  for kp in $survivors; do kill -9 "$kp" 2>/dev/null; done
fi

# --- 5: RATCHET — .rc publishes via tmp+rename ---------------------------------
# The parent treats .rc PRESENCE as "done" and its CONTENT as a complete
# integer; a bare `>` write has an open→write window a parent poll can land in.
if grep -q 'rc\.tmp' "$helper" && grep -q 'mv -f' "$helper"; then
  echo "  ✓ rc-atomic: run-suite publishes .rc via tmp+rename"
else
  echo "  ✗ rc-atomic: tmp+rename idiom missing from run-suite.sh"; fail=1
fi

exit "$fail"
