#!/usr/bin/env bash
# ============================================================================
#  scripts/scribe/live-reap-check.sh — R5e LIVE owner-SIGKILL reap proof.
#
#  The gold-standard end-to-end check that the auto-started daemon SELF-REAPS
#  when its owner dies by SIGKILL — the exact case process.once('exit') misses
#  (and the case the R5b (pid,start-token) identity hardens against pid-reuse).
#  HEAVY (spawns the real daemon, ~25s) so it is NOT in run-all.sh; run manually.
#
#  Isolated: a temp MERCURY_CONFIG_DIR (own socket + supervisor state), no
#  Implementer (MERCURY_AMANUENSIS=0), no live bus, cron disabled. Cleanup uses
#  SPECIFIC pids only — never a broad pkill (a co-resident daemon for another
#  project must be left untouched).
#
#  Verified PASS: daemon gone ~6s after owner SIGKILL (grace ~8s).
#  Run:  bash scripts/scribe/live-reap-check.sh   (needs a prior `bun run build.ts`)
# ============================================================================
set -u
BIN="$(cd "$(dirname "$0")/../.." && pwd)/dist/mercury.mjs"
TMPCFG="$(mktemp -d /tmp/r5e-cfg.XXXXXX)"

sleep 120 &
OWNER=$!
echo "owner(sleep) pid=$OWNER"

MERCURY_SCRIBE_OWNER_PID=$OWNER MERCURY_AMANUENSIS=0 MERCURY_SCRIBE_BUS_LIVE=0 \
  MERCURY_CONFIG_DIR="$TMPCFG" MERCURY_SATURN_DISABLE=1 \
  node "$BIN" daemon >/tmp/r5e-daemon.log 2>&1 &
DAEMON=$!
echo "daemon pid=$DAEMON"
sleep 3

rc=0
if ! kill -0 "$DAEMON" 2>/dev/null; then
  echo "RESULT=INCONCLUSIVE (daemon did not stay up):"; tail -5 /tmp/r5e-daemon.log; rc=2
else
  echo "daemon alive before owner-kill: yes"
  kill -9 "$OWNER" 2>/dev/null
  echo "owner SIGKILLed at t=0; polling for self-reap (grace ~8s)…"
  REAPED=no
  for i in $(seq 1 20); do
    sleep 1
    if ! kill -0 "$DAEMON" 2>/dev/null; then REAPED=yes; echo "daemon gone at ~${i}s"; break; fi
  done
  if [ "$REAPED" = "yes" ]; then echo "RESULT=PASS (daemon self-reaped after owner SIGKILL)"; else
    echo "RESULT=FAIL (daemon STILL ALIVE 20s after owner death):"; tail -8 /tmp/r5e-daemon.log; rc=1
  fi
fi

kill -9 "$DAEMON" 2>/dev/null; kill -9 "$OWNER" 2>/dev/null; rm -rf "$TMPCFG"
exit "$rc"
