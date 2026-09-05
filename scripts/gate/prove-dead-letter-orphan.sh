#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
fail=0
check() { if [ "$2" = "0" ]; then echo "  [PASS] $1"; else echo "  [FAIL] $1${3:+ — $3}"; fail=1; fi; }

dir=$(mktemp -d "${TMPDIR:-/tmp}/dead-letter-orphan.XXXXXX")
/bin/sh -c "/usr/bin/python3 scripts/gate/dead-letter.py '$dir/port' & sleep 600" &
parent=$!
for _ in $(seq 1 40); do [ -s "$dir/port" ] && break; sleep 0.25; done
[ -s "$dir/port" ] || { check "the box started under its parent" 1 "no port file"; kill -9 "$parent" 2>/dev/null; rm -rf "$dir"; exit 1; }
port=$(cat "$dir/port")
box=$(pgrep -f "dead-letter.py $dir/port" | head -1)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -d '{}' "http://127.0.0.1:$port/v1/messages" 2>/dev/null || true)
[ "$code" = "401" ]; check "D1 the box answers while its parent lives (port $port, pid ${box:-?}, HTTP $code)" $?
[ -n "$box" ] || check "the box's pid is visible" 1

kill -9 "$parent" 2>/dev/null
wait "$parent" 2>/dev/null
gone=1
for _ in $(seq 1 24); do
  if ! kill -0 "$box" 2>/dev/null; then gone=0; break; fi
  sleep 0.25
done
check "D2 the box exited on its own within 6 s of its parent's death" "$gone" "pid $box still alive"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null || true)
check "D2 the port no longer answers" "$([ "$code" = "000" ] || [ -z "$code" ]; echo $?)" "answered $code"
kill -9 "$box" 2>/dev/null
rm -rf "$dir"

if [ -f dist/mercury.mjs ]; then
  dhome=$(mktemp -d "${TMPDIR:-/tmp}/dead-letter-daemon.XXXXXX")
  mkdir -p "$dhome/config" "$dhome/daemon" "$dhome/project"
  /usr/bin/python3 - "$dhome" <<'PY' &
import os, subprocess, sys, time
home = sys.argv[1]
r, w = os.pipe()
env = dict(os.environ, MERCURY_CONFIG_DIR=os.path.join(home, 'config'), MERCURY_DAEMON_DIR=os.path.join(home, 'daemon'), MERCURY_CREDENTIAL_STORE='file', MERCURY_DAEMON_OWNER_FD='3', MERCURY_DAEMON_OWNER_PID=str(os.getpid()), MERCURY_TERMINAL_TITLE='0')
def to_fd3():
    os.dup2(r, 3)
p = subprocess.Popen(['node', 'dist/mercury.mjs', 'daemon', 'run', os.path.join(home, 'project')], env=env, preexec_fn=to_fd3, pass_fds=[r], stdin=subprocess.DEVNULL, stdout=open(os.path.join(home, 'daemon.log'), 'a'), stderr=subprocess.STDOUT)
open(os.path.join(home, 'daemon.pid'), 'w').write(str(p.pid))
time.sleep(600)
PY
  parent=$!
  for _ in $(seq 1 80); do [ -s "$dhome/daemon.pid" ] && break; sleep 0.25; done
  dpid=$(cat "$dhome/daemon.pid" 2>/dev/null)
  sleep 3
  if [ -n "$dpid" ] && kill -0 "$dpid" 2>/dev/null; then
    check "D3 the owned daemon runs under its parent (pid $dpid)" 0
    kill -9 "$parent" 2>/dev/null
    wait "$parent" 2>/dev/null
    dgone=1
    for _ in $(seq 1 40); do
      if ! kill -0 "$dpid" 2>/dev/null; then dgone=0; break; fi
      sleep 0.25
    done
    check "D3 the owned daemon exited on its own within 10 s of its parent's SIGKILL (the owner pipe's EOF)" "$dgone" "pid $dpid still alive; log: $(tail -c 400 "$dhome/daemon.log" 2>/dev/null | tr '\n' ' ')"
    kill -9 "$dpid" 2>/dev/null
  else
    check "D3 the owned daemon started under the python parent" 1 "no live daemon pid ($(tail -3 "$dhome/daemon.log" 2>/dev/null | tr '\n' ' '))"
    kill -9 "$parent" 2>/dev/null
  fi
  rm -rf "$dhome"
else
  echo "  [NOTE] dist/mercury.mjs absent — D3 (the owned daemon) not checkable here"
fi
[ "$fail" = "0" ] && echo "prove-dead-letter-orphan: all green" || echo "prove-dead-letter-orphan: FAILURE(S)"
exit "$fail"
