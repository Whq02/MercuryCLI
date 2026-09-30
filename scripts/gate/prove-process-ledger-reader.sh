#!/usr/bin/env bash
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0
pass() { echo "  [PASS] $1"; }
red() { echo "  [FAIL] $1${2:+ — $2}"; fail=1; }
check() { if [ "$2" = 0 ]; then pass "$1"; else red "$1" "${3:-}"; fi; }
case "$(uname -s)" in (MINGW* | MSYS* | CYGWIN*) echo "SKIP process-ledger-reader: POSIX process semantics only"; exit 0 ;; esac
. "$root/scripts/lib/process-ledger.sh"

work=$(mktemp -d "${TMPDIR:-/tmp}/process-ledger-reader.XXXXXX")
pids=""
cleanup() {
  local p
  for p in $pids; do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done
  rm -rf "$work"
}
trap cleanup EXIT
fixture() { sleep 600 >/dev/null 2>&1 & last=$!; pids="$pids $last"; }
started_of() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'; }
gone_within() {
  local p=$1 n=0
  while [ "$n" -lt 30 ]; do process_alive "$p" || return 0; sleep 0.1; n=$((n + 1)); done
  return 1
}
entry() { printf '%s\t%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" "$6" >"$1"; }
bash -c 'exit 0' & dead=$!; wait "$dead" 2>/dev/null

echo "── the reaper keeps an entry's columns aligned"
ledger="$work/ledger"; mkdir -p "$ledger"
fixture; full=$last; fixture; empty=$last; fixture; qmark=$last; fixture; nocwd=$last; fixture; recycled=$last
entry "$ledger/$full.$dead.entry" "$full" "$dead" "$(started_of "$full")" "$work" "sleep 600"
entry "$ledger/$empty.entry" "$empty" "$dead" "" "$work" "sleep 600"
entry "$ledger/$qmark.entry" "$qmark" "$dead" "?" "$work" "sleep 600"
entry "$ledger/$nocwd.entry" "$nocwd" "$dead" "$(started_of "$nocwd")" "" "sleep 600"
entry "$ledger/$recycled.$dead.entry" "$recycled" "$dead" "Mon Jan  1 00:00:00 2001" "$work" "sleep 600"
entry "$ledger/$dead.entry" "$dead" "$dead" "" "$work" "bash -c exit"
out=$(process_ledger_reap "$ledger")
check "an entry with every column is reaped" "$(gone_within "$full" && echo 0 || echo 1)" "pid $full still alive"
check "an entry with an EMPTY start time is reaped (the writer could not ask ps)" "$(gone_within "$empty" && echo 0 || echo 1)" "pid $empty still alive"
check "…and its command column is read as written, not shifted" "$(case "$out" in *"ended $empty (sleep 600)"*) echo 0 ;; *) echo 1 ;; esac)" "$out"
check "an entry whose start time is the ? placeholder is reaped the same way" "$(gone_within "$qmark" && echo 0 || echo 1)" "pid $qmark still alive"
check "an entry with an empty working-folder column is reaped" "$(gone_within "$nocwd" && echo 0 || echo 1)" "pid $nocwd still alive"
check "an entry whose recorded start time is another process's is dropped without a kill (the identity law)" "$(process_alive "$recycled" && [ ! -f "$ledger/$recycled.$dead.entry" ] && echo 0 || echo 1)" "pid $recycled alive=$(process_alive "$recycled" && echo yes || echo no) entry=$([ -f "$ledger/$recycled.$dead.entry" ] && echo kept || echo dropped)"
check "an entry naming a dead pid is dropped" "$([ ! -f "$ledger/$dead.entry" ] && echo 0 || echo 1)"
check "no entry survives the reap" "$([ -z "$(ls -A "$ledger")" ] && echo 0 || echo 1)" "$(ls "$ledger" | tr '\n' ' ')"

echo "── --only-dead-runners reads the runner column of an entry with an empty start time"
ledger2="$work/ledger2"; mkdir -p "$ledger2"
fixture; held=$last; fixture; orphan=$last
entry "$ledger2/$held.entry" "$held" "$$" "" "$work" "sleep 600"
entry "$ledger2/$orphan.entry" "$orphan" "$dead" "" "$work" "sleep 600"
process_ledger_reap "$ledger2" --only-dead-runners >/dev/null
check "an entry whose runner is alive is left alone, its entry kept" "$(process_alive "$held" && [ -f "$ledger2/$held.entry" ] && echo 0 || echo 1)" "alive=$(process_alive "$held" && echo yes || echo no) entry=$([ -f "$ledger2/$held.entry" ] && echo kept || echo dropped)"
check "an entry whose runner is gone is reaped" "$(gone_within "$orphan" && [ ! -f "$ledger2/$orphan.entry" ] && echo 0 || echo 1)" "pid $orphan alive=$(process_alive "$orphan" && echo yes || echo no)"

echo "── the orphan sweep reads the same shape"
ledger3="$work/ledger3"; mkdir -p "$ledger3"
bash -c 'exec -a mercury sleep 600' >/dev/null 2>&1 & swept=$!; pids="$pids $swept"
sleep 0.2
entry "$ledger3/$swept.$dead.entry" "$swept" "$dead" "" "$work" "mercury 600"
dry=$(MERCURY_SWEEP_ONLY_PIDS="$swept" MERCURY_PROCESS_LEDGER_DIR="$ledger3" bash "$root/scripts/lib/sweep-orphans.sh" --dry-run 2>&1)
check "a dry sweep names the process whose entry (an empty start time) ties it to a dead runner" "$(case "$dry" in *"would end $swept "*"ledger names runner $dead, which is gone"*) echo 0 ;; *) echo 1 ;; esac)" "$dry"
check "…and ends nothing on a dry run" "$(process_alive "$swept" && echo 0 || echo 1)"

if [ "$fail" = 0 ]; then echo "  ALL PASS"; else echo "  FAILED"; fi
exit "$fail"
