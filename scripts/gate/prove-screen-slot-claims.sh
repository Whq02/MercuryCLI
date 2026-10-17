#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
fail=0
pass() { echo "  [PASS] $1"; }
red() { echo "  [FAIL] $1${2:+ — $2}"; fail=1; }
check() { if [ "$2" = 0 ]; then pass "$1"; else red "$1" "${3:-}"; fi; }

temp="${TMPDIR:-/tmp}"
scratch="$(mktemp -d "${temp%/}/screen-slot.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
export SCREEN_SLOTS_DIR="$scratch/slots"
export SCREEN_SLOT_POLL_SECONDS=0
export SCREEN_SLOT_POLL_LIMIT=2
. "$root/scripts/lib/screen-slot.sh"

echo "── §1 a claim carries its pid"
screen_slot_take 2 >"$scratch/out"; rc=$?
check "the first claim takes slot 1" "$([ "$rc" = 0 ] && [ "$SCREEN_SLOT" = 1 ] && echo 0 || echo 1)" "rc=$rc slot=$SCREEN_SLOT"
check "…and writes this shell's pid" "$([ "$(cat "$SCREEN_SLOTS_DIR/slot-1/pid")" = "$$" ] && echo 0 || echo 1)" "$(cat "$SCREEN_SLOTS_DIR/slot-1/pid" 2>/dev/null)"
check "…saying nothing (no takeover)" "$([ ! -s "$scratch/out" ] && echo 0 || echo 1)" "$(cat "$scratch/out")"
first_dir="$SCREEN_SLOT_DIR"

echo "── §2 a live claim is respected: the next claimer takes the next slot, then waits"
sleep 300 & sleeper=$!
mkdir "$SCREEN_SLOTS_DIR/slot-2" && printf '%s\n' "$sleeper" >"$SCREEN_SLOTS_DIR/slot-2/pid"
( . "$root/scripts/lib/screen-slot.sh"; screen_slot_take 2 >"$scratch/out2" 2>"$scratch/err2"; echo "rc=$?" >>"$scratch/out2" )
check "both slots held by live pids: the claimer gives up after its bounded waits" "$(grep -q '^rc=1$' "$scratch/out2" && grep -q 'none of 2 free after 2 wait' "$scratch/err2" && echo 0 || echo 1)" "$(cat "$scratch/out2" "$scratch/err2")"
check "…and the live claims stand" "$([ "$(cat "$SCREEN_SLOTS_DIR/slot-2/pid")" = "$sleeper" ] && [ "$(cat "$SCREEN_SLOTS_DIR/slot-1/pid")" = "$$" ] && echo 0 || echo 1)"

echo "── §3 a claim whose pid is gone is taken, and said"
kill "$sleeper" 2>/dev/null; wait "$sleeper" 2>/dev/null
( . "$root/scripts/lib/screen-slot.sh"; screen_slot_take 2 >"$scratch/out3" 2>&1; echo "slot=$SCREEN_SLOT rc=$?" >>"$scratch/out3"; echo "pid=$(cat "$SCREEN_SLOT_DIR/pid")" >>"$scratch/out3" )
check "the dead claim's slot is taken" "$(grep -q '^slot=2' "$scratch/out3" && echo 0 || echo 1)" "$(cat "$scratch/out3")"
check "…the line names the gone pid" "$(grep -q "screen slot 2: the claim of pid $sleeper is gone — taken" "$scratch/out3" && echo 0 || echo 1)" "$(cat "$scratch/out3")"
check "…and the claim now carries the new claimant's pid" "$(grep -q '^pid=[0-9][0-9]*$' "$scratch/out3" && ! grep -q "^pid=$sleeper\$" "$scratch/out3" && echo 0 || echo 1)" "$(grep '^pid=' "$scratch/out3")"

echo "── §4 refusals: an older claim without a pid is left alone; a foreign pid file too"
rm -rf "$SCREEN_SLOTS_DIR/slot-2"
mkdir "$SCREEN_SLOTS_DIR/slot-2"
( . "$root/scripts/lib/screen-slot.sh"; screen_slot_take 2 >"$scratch/out4" 2>&1; echo "rc=$?" >>"$scratch/out4" )
check "a pid-less claim is never taken over" "$(grep -q '^rc=1$' "$scratch/out4" && [ -d "$SCREEN_SLOTS_DIR/slot-2" ] && [ ! -e "$SCREEN_SLOTS_DIR/slot-2/pid" ] && echo 0 || echo 1)" "$(cat "$scratch/out4")"
printf 'not-a-pid\n' >"$SCREEN_SLOTS_DIR/slot-2/pid"
( . "$root/scripts/lib/screen-slot.sh"; screen_slot_take 2 >"$scratch/out5" 2>&1; echo "rc=$?" >>"$scratch/out5" )
check "a claim whose pid file is not a number is left alone" "$(grep -q '^rc=1$' "$scratch/out5" && [ "$(cat "$SCREEN_SLOTS_DIR/slot-2/pid")" = not-a-pid ] && echo 0 || echo 1)" "$(cat "$scratch/out5")"
check "a pid of 1 (init, always alive) is respected" "$(printf '1\n' >"$SCREEN_SLOTS_DIR/slot-2/pid"; ( . "$root/scripts/lib/screen-slot.sh"; screen_slot_take 2 >/dev/null 2>&1 ); [ "$?" = 1 ] && [ "$(cat "$SCREEN_SLOTS_DIR/slot-2/pid")" = 1 ] && echo 0 || echo 1)"

echo "── §5 release"
screen_slot_free
check "freeing removes the pid file and the slot" "$([ ! -e "$first_dir" ] && [ -z "$SCREEN_SLOT" ] && echo 0 || echo 1)"
screen_slot_free
check "a second free is a no-op" "$([ ! -e "$first_dir" ] && echo 0 || echo 1)"

[ "$fail" = 0 ] && echo "prove-screen-slot-claims: green" || echo "prove-screen-slot-claims: RED"
exit "$fail"
