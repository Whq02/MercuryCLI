#!/usr/bin/env bash
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
sweep="$root/scripts/lib/sweep-orphans.sh"
python="${MERCURY_PYTHON:-/usr/bin/python3}"
case "$(uname -s)" in (MINGW* | MSYS* | CYGWIN*) echo "SKIP orphan-sweep: POSIX process semantics only"; exit 0 ;; esac
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/orphan-sweep-proof.XXXXXX")
work=$(cd "$work" && pwd -P)
export MERCURY_PROCESS_LEDGER_DIR="$work/ledger"
mkdir -p "$work/dist" "$work/ledger" "$work/marks"
cat >"$work/dist/mercury.mjs" <<'EOF'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
process.title = 'mercury'
const gh = spawn('sleep', ['600'], { stdio: 'ignore' })
writeFileSync(`${process.env.MARKS}/${process.env.MARK}.pid`, `${process.pid} ${gh.pid}\n`)
process.stdout.write('fixture up\n')
process.on('SIGHUP', () => {})
setInterval(() => {}, 1 << 30)
EOF
cat >"$work/holder.py" <<'EOF'
import os, pty, sys, time, select
mode = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
if mode == 'hold':
    while True:
        r, _, _ = select.select([fd], [], [], 1.0)
        if fd in r:
            try:
                if not os.read(fd, 65536):
                    break
            except OSError:
                break
    sys.exit(0)
time.sleep(1.5)
os._exit(0)
EOF
export MARKS="$work/marks" NODE_BIN="$(command -v node)"
cleanup() {
  local f p g
  for f in "$work"/marks/*.pid; do
    [ -f "$f" ] || continue
    read -r p g <"$f"
    for x in $p $g; do kill -CONT "$x" 2>/dev/null; kill -9 "$x" 2>/dev/null; done
  done
  [ -n "${holder_live:-}" ] && kill -9 "$holder_live" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT
wait_mark() {
  local n=0
  while [ ! -f "$work/marks/$1.pid" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
  [ -f "$work/marks/$1.pid" ]
}
state() { ps -o stat= -p "$1" 2>/dev/null | tr -d ' '; }
both_alive() { local p g; read -r p g <"$work/marks/$1.pid"; kill -0 "$p" 2>/dev/null && kill -0 "$g" 2>/dev/null; }
both_gone() { local p g; read -r p g <"$work/marks/$1.pid"; ! kill -0 "$p" 2>/dev/null && ! kill -0 "$g" 2>/dev/null; }
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

echo "§1 the fixtures: an orphan of a dead run in a deleted scratch folder, a live run, a run whose terminal is gone, a ledger orphan"
detach() { local cwd=$1; shift; "$python" -c 'import os, subprocess, sys
subprocess.Popen(sys.argv[2:], cwd=sys.argv[1], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os._exit(0)' "$cwd" "$@"; }
mkdir -p "$work/gone-cwd" "$work/live-cwd" "$work/ledger-cwd"
MARK=dead-scratch detach "$work/gone-cwd" "$NODE_BIN" "$work/dist/mercury.mjs"
wait_mark dead-scratch || { echo "  ✗ the dead-scratch fixture did not start"; fail=1; }
read -r dead_pid dead_gh <"$work/marks/dead-scratch.pid"
sleep 0.5
rmdir "$work/gone-cwd" 2>/dev/null || rm -rf "$work/gone-cwd"
kill -STOP "$dead_pid" 2>/dev/null

( cd "$work/live-cwd" && MARK=live exec "$NODE_BIN" "$work/dist/mercury.mjs" >/dev/null 2>&1 ) &
live_parent=$!
wait_mark live || { echo "  ✗ the live fixture did not start"; fail=1; }
read -r live_pid live_gh <"$work/marks/live.pid"

MARK=terminal-gone detach "$work/live-cwd" "$python" "$work/holder.py" leave "$NODE_BIN" "$work/dist/mercury.mjs"
wait_mark terminal-gone || { echo "  ✗ the terminal-gone fixture did not start"; fail=1; }
read -r tg_pid tg_gh <"$work/marks/terminal-gone.pid"

MARK=terminal-held "$python" "$work/holder.py" hold "$NODE_BIN" "$work/dist/mercury.mjs" >/dev/null 2>&1 &
holder_live=$!
wait_mark terminal-held || { echo "  ✗ the terminal-held fixture did not start"; fail=1; }
read -r th_pid th_gh <"$work/marks/terminal-held.pid"

MARK=ledger detach "$work/ledger-cwd" "$NODE_BIN" "$work/dist/mercury.mjs"
wait_mark ledger || { echo "  ✗ the ledger fixture did not start"; fail=1; }
read -r ledger_pid ledger_gh <"$work/marks/ledger.pid"
sleep 600 &
dead_runner=$!
kill -9 "$dead_runner"; wait "$dead_runner" 2>/dev/null
printf '%s\t%s\t%s\t%s\t%s\n' "$ledger_pid" "$dead_runner" "$(ps -o lstart= -p "$ledger_pid" | sed 's/^ *//; s/ *$//')" "$work" "node $work/dist/mercury.mjs" >"$work/ledger/$ledger_pid.$dead_runner.entry"

export MERCURY_SWEEP_ONLY_PIDS="$dead_pid $live_pid $tg_pid $th_pid $ledger_pid"
sleep 2.5
for m in dead-scratch terminal-gone ledger; do
  read -r p g <"$work/marks/$m.pid"
  [ "$(ppid_of "$p")" = 1 ] || { echo "  ✗ the $m fixture did not reach ppid 1 (ppid $(ppid_of "$p"))"; fail=1; }
done
echo "  fixtures: dead-scratch $dead_pid ($(state "$dead_pid"), ppid $(ppid_of "$dead_pid")) · live $live_pid (ppid $(ppid_of "$live_pid")) · terminal-gone $tg_pid (ppid $(ppid_of "$tg_pid")) · terminal-held $th_pid (ppid $(ppid_of "$th_pid")) · ledger $ledger_pid (ppid $(ppid_of "$ledger_pid"), runner $dead_runner gone)"

echo "§2 a dry run names the orphans and ends nothing"
dry=$(bash "$sweep" --dry-run 2>&1)
printf '%s\n' "$dry" | sed 's/^/    /'
if printf '%s\n' "$dry" | grep -q "would end $dead_pid .*scratch folder .* is deleted" && printf '%s\n' "$dry" | grep -q "would end $tg_pid .*nobody holds the other side of its terminal" && printf '%s\n' "$dry" | grep -q "would end $ledger_pid .*ledger names runner $dead_runner, which is gone"; then echo "  ✓ the three orphans are named with their reasons"; else echo "  ✗ the dry run did not name the three orphans with their reasons"; fail=1; fi
if ! printf '%s\n' "$dry" | grep -q "would end $live_pid " && ! printf '%s\n' "$dry" | grep -q "would end $th_pid "; then echo "  ✓ the live run and the run whose terminal is held are not named"; else echo "  ✗ a live fixture was named for ending"; fail=1; fi
if both_alive dead-scratch && both_alive live && both_alive terminal-gone && both_alive terminal-held && both_alive ledger; then echo "  ✓ a dry run ended nothing"; else echo "  ✗ the dry run ended a fixture"; fail=1; fi

echo "§3 the sweep ends the orphans of dead runs — and only those"
out=$(bash "$sweep" 2>&1)
printf '%s\n' "$out" | sed 's/^/    /'
sleep 1
if both_gone dead-scratch; then echo "  ✓ the stopped orphan in a deleted scratch folder is ended with its gh-shaped child"; else echo "  ✗ the deleted-scratch orphan survives: $(state "$dead_pid") / gh $(state "$dead_gh")"; fail=1; fi
if both_gone terminal-gone; then echo "  ✓ the orphan whose terminal nobody holds is ended with its child"; else echo "  ✗ the terminal-gone orphan survives: $(state "$tg_pid") / gh $(state "$tg_gh")"; fail=1; fi
if both_gone ledger; then echo "  ✓ the orphan the ledger ties to a dead runner is ended with its child"; else echo "  ✗ the ledger orphan survives: $(state "$ledger_pid") / gh $(state "$ledger_gh")"; fail=1; fi
if both_alive live && [ "$(ppid_of "$live_pid")" = "$$" ]; then echo "  ✓ the live run (its runner alive) is untouched"; else echo "  ✗ the live run was ended or lost its runner"; fail=1; fi
if both_alive terminal-held && kill -0 "$holder_live" 2>/dev/null; then echo "  ✓ the run whose terminal is still held (its runner gone) is untouched"; else echo "  ✗ the terminal-held run was ended"; fail=1; fi
if printf '%s\n' "$out" | grep -q '^orphan sweep: 3 ended, '; then echo "  ✓ the sweep's summary counts three ended"; else echo "  ✗ the summary does not read three ended: $(printf '%s\n' "$out" | tail -1)"; fail=1; fi

if [ "$fail" = 0 ]; then echo "PASS orphan-sweep — the sweep ends the orphans of dead runs, never a live run's process"; else echo "FAIL orphan-sweep"; fi
exit "$fail"
