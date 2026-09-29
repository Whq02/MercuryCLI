#!/usr/bin/env bash
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
helper="$root/scripts/gate/run-suite.sh"
engine="$root/scripts/ui/vshot.py"
python="${MERCURY_PYTHON:-/usr/bin/python3}"
case "$(uname -s)" in (MINGW* | MSYS* | CYGWIN*) echo "SKIP runner-ends-children: POSIX process semantics only"; exit 0 ;; esac
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/runner-ends-children.XXXXXX")
ledger="$work/ledger"; mkdir -p "$ledger" "$work/marks"
export MERCURY_PROCESS_LEDGER_DIR="$ledger"
cleanup_marks() {
  local f p g
  for f in "$work"/marks/*.pid; do
    [ -f "$f" ] || continue
    read -r p g <"$f"
    for x in $p $g; do kill -CONT "$x" 2>/dev/null; kill -9 "$x" 2>/dev/null; done
  done
}
trap 'cleanup_marks; rm -rf "$work"' EXIT

cat >"$work/gh-sleeper.mjs" <<'EOF'
setInterval(() => {}, 1 << 30)
EOF
cat >"$work/product.mjs" <<'EOF'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
process.title = 'mercury'
const gh = spawn(process.execPath, [process.env.GH_SLEEPER, 'api', 'repos/fixture/repo', '--jq', '.private'], { stdio: 'ignore' })
writeFileSync(`${process.env.MARKS}/${process.env.MARK}.pid`, `${process.pid} ${gh.pid}\n`)
process.stdout.write('product up\n')
process.on('SIGHUP', () => process.exit(129))
setInterval(() => {}, 1 << 30)
EOF
export GH_SLEEPER="$work/gh-sleeper.mjs" MARKS="$work/marks"

alive_after() {
  local mark=$1 secs=$2 p g n=0
  read -r p g <"$work/marks/$mark.pid" || { echo "no mark for $mark"; return 2; }
  while [ "$n" -lt "$secs" ]; do
    if ! kill -0 "$p" 2>/dev/null && ! kill -0 "$g" 2>/dev/null; then echo "none"; return 0; fi
    sleep 1; n=$((n + 1))
  done
  echo "product $p: $(ps -o stat= -p "$p" 2>/dev/null || echo gone) · grandchild $g: $(ps -o stat= -p "$g" 2>/dev/null || echo gone)"
  return 1
}

mk_cfg() {
  local mark=$1 total=$2 stop=$3
  printf '{"argv":["%s","%s"],"cols":80,"rows":24,"total":%s,"out":"%s","sends":[%s]}\n' "$(command -v node)" "$work/product.mjs" "$total" "$work/$mark.grid.json" \
    "$([ "$stop" = 1 ] && printf '{"atTick":4,"signal":"SIGSTOP"}')" >"$work/$mark.json"
}

echo "§1 the capture engine ends its product child and grandchild at its own end, a stopped child included"
mk_cfg engine-end 12 1
MARK=engine-end "$python" "$engine" "$work/engine-end.json" >/dev/null 2>&1
left=$(alive_after engine-end 6)
if [ "$left" = none ]; then echo "  ✓ engine end: nothing of the capture survives"; else echo "  ✗ engine end left: $left"; fail=1; fi
if [ -z "$(ls -A "$ledger" 2>/dev/null)" ]; then echo "  ✓ engine end: its ledger entry is removed"; else echo "  ✗ engine end: ledger entries remain: $(ls "$ledger")"; fail=1; fi

echo "§2 the proof-level wall's SIGTERM to the engine ends the product child and grandchild"
mk_cfg engine-term 300 1
MARK=engine-term "$python" "$engine" "$work/engine-term.json" >/dev/null 2>&1 &
epid=$!
n=0; while [ ! -f "$work/marks/engine-term.pid" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
sleep 2
kill -TERM "$epid" 2>/dev/null
wait "$epid" 2>/dev/null
left=$(alive_after engine-term 8)
if [ "$left" = none ]; then echo "  ✓ SIGTERM to the engine: nothing of the capture survives"; else echo "  ✗ SIGTERM to the engine left: $left"; fail=1; fi

echo "§3 the suite wall ends a stopped product child whose engine was killed without its ending (the ledger names it)"
mkdir -p "$work/suite-ledger" "$work/out"
mk_cfg wall-orphan 600 0
cat >"$work/suite-ledger/run-all.sh" <<EOF
#!/usr/bin/env bash
MARK=wall-orphan $python $engine $work/wall-orphan.json >/dev/null 2>&1 &
engine=\$!
n=0; while [ ! -f "$work/marks/wall-orphan.pid" ] && [ "\$n" -lt 100 ]; do sleep 0.1; n=\$((n + 1)); done
read -r p g <"$work/marks/wall-orphan.pid"
kill -STOP "\$p"
kill -9 "\$engine"
sleep 600
EOF
bash "$helper" "$work/suite-ledger/run-all.sh" 8 "$work/out" >/dev/null 2>&1
left=$(alive_after wall-orphan 6)
if [ "$left" = none ] && [ -f "$work/out/suite-ledger.hang" ]; then echo "  ✓ suite wall: the killed engine's stopped child and its grandchild are ended with the tree"; else echo "  ✗ suite wall left: $left (hang sidecar: $([ -f "$work/out/suite-ledger.hang" ] && echo yes || echo no))"; fail=1; fi
grep -a 'process ledger: ended' "$work/out/suite-ledger.out" 2>/dev/null | sed 's/^/    /'

echo "§4 a SIGKILLed run-suite.sh ends its suite's tree at once, not at the wall"
mkdir -p "$work/suite-kill"
printf '#!/usr/bin/env bash\nMARK=runner-killed %s %s &\nsleep 600\nwait\n' "$(command -v node)" "$work/product.mjs" >"$work/suite-kill/run-all.sh"
bash "$helper" "$work/suite-kill/run-all.sh" 120 "$work/out" >/dev/null 2>&1 &
rpid=$!
n=0; while [ ! -f "$work/marks/runner-killed.pid" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
sleep 1
kill -9 "$rpid" 2>/dev/null
wait "$rpid" 2>/dev/null
left=$(alive_after runner-killed 10)
if [ "$left" = none ]; then echo "  ✓ SIGKILL of the runner: the suite's product child and grandchild are gone within 10 s"; else echo "  ✗ SIGKILL of the runner left (after 10 s): $left"; fail=1; fi
pkill -9 -f "$work/suite-kill/run-all.sh" 2>/dev/null

if [ "$fail" = 0 ]; then echo "PASS runner-ends-children — every runner exit ends the product it booted"; else echo "FAIL runner-ends-children"; fi
exit "$fail"
