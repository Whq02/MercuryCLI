#!/usr/bin/env bash
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

mk_suite green 'echo hello-from-green; exit 0'
if bash "$helper" "$work/green/run-all.sh" 30 "$out" \
   && [ "$(cat "$out/green.rc")" = "0" ] \
   && grep -q hello-from-green "$out/green.out"; then
  echo "  ✓ green: rc 0 propagated, output captured"
else
  echo "  ✗ green case broken"; fail=1
fi

mk_suite red 'echo boom >&2; exit 3'
bash "$helper" "$work/red/run-all.sh" 30 "$out"; rc=$?
if [ "$rc" = "3" ] && [ "$(cat "$out/red.rc")" = "3" ] && grep -q boom "$out/red.out" && [ ! -f "$out/red.hang" ]; then
  echo "  ✓ red: rc 3 propagated (helper + rc file), stderr captured, no hang sidecar"
else
  echo "  ✗ red case broken (helper rc=$rc, file=$(cat "$out/red.rc" 2>/dev/null))"; fail=1
fi

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

if grep -q 'rc\.tmp' "$helper" && grep -q 'mv -f' "$helper"; then
  echo "  ✓ rc-atomic: run-suite publishes .rc via tmp+rename"
else
  echo "  ✗ rc-atomic: tmp+rename idiom missing from run-suite.sh"; fail=1
fi

exit "$fail"
