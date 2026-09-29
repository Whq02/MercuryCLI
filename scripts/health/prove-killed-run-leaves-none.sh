#!/usr/bin/env bash
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
helper="$root/scripts/gate/run-suite.sh"
engine="$root/scripts/ui/vshot.py"
python="${MERCURY_PYTHON:-/usr/bin/python3}"
bun="${BUN:-$HOME/.bun/bin/bun}"
dist="${MERCURY_KILLED_RUN_DIST:-$root/dist}"
node_bin="$dist/vendor/node/bin/node"
[ -x "$node_bin" ] || node_bin="$(command -v node)"
case "$(uname -s)" in (MINGW* | MSYS* | CYGWIN*) echo "SKIP killed-run-leaves-none: POSIX process semantics only"; exit 0 ;; esac
if [ ! -f "$dist/mercury.mjs" ]; then echo "FAIL killed-run-leaves-none: $dist/mercury.mjs is missing — run \`bun run build.ts\`"; exit 1; fi
scale="${MERCURY_VSHOT_BUDGET_SCALE:-1}"
fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/killed-run.XXXXXX")
work=$(cd "$work" && pwd -P)
mkdir -p "$work/out"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-proof-key-ci-gate-not-a-real-key}"
export MERCURY_CREDENTIAL_STORE=file MERCURY_LOCAL_PROBE_TARGETS=none MERCURY_DAEMON_NO_SELF_WARM=1 BROWSER=/usr/bin/true TERM=xterm-256color VSHOT_SLOTS="${VSHOT_SLOTS:-999}"
unset MERCURY_HOME
snapshot=""
run_processes() {
  local pids="" p
  for p in $snapshot; do kill -0 "$p" 2>/dev/null && pids="$pids $p"; done
  for p in $(lsof -a -u "$(id -u)" -d cwd -Fpn 2>/dev/null | awk -v w="$work" '/^p/{pid=substr($0,2)} /^n/{if (index(substr($0,2), w)==1) print pid}'); do
    case " $pids " in (*" $p "*) ;; (*) if kill -0 "$p" 2>/dev/null; then pids="$pids $p"; fi ;; esac
  done
  printf '%s' "${pids# }"
}
describe() { local p; for p in $1; do printf '%s %s %s; ' "$p" "$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ')" "$(ps -o command= -p "$p" 2>/dev/null | cut -c1-50)"; done; }
cleanup() {
  local p
  for p in $(run_processes); do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done
  for p in $snapshot; do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done
  rm -rf "$work"
}
trap cleanup EXIT

make_run() {
  local tag=$1 home="$work/$1-home" cwd="$work/$1-cwd"
  mkdir -p "$home" "$cwd"
  "$bun" run "$root/scripts/lib/firstRunSeed.ts" "$home" "$cwd" >/dev/null 2>&1
  printf '{"argv":["%s","%s"],"cwd":"%s","cols":100,"rows":30,"total":%s,"out":"%s","sends":[]}\n' "$node_bin" "$dist/mercury.mjs" "$cwd" "$(awk -v s="$scale" 'BEGIN{printf "%d", 900*s}')" "$work/$tag.grid.json" >"$work/$tag.cfg.json"
  cat >"$work/$tag-suite-run-all.sh" <<EOF
#!/usr/bin/env bash
export MERCURY_CONFIG_DIR="$home" MERCURY_DAEMON_DIR="$home/daemon" MERCURY_DOCTOR_STATE_DIR="$home/doctor"
"$python" "$engine" "$work/$tag.cfg.json" >"$work/$tag.engine.out" 2>&1 &
engine=\$!
echo "\$engine" >"$work/$tag.engine.pid"
n=0; while [ "\$n" -lt 600 ]; do sleep 0.2; n=\$((n + 1)); p=\$(pgrep -P "\$engine" | head -1); [ -n "\$p" ] && ps -o command= -p "\$p" 2>/dev/null | grep -q -E 'mercury|node' && { echo "\$p" >"$work/$tag.product.pid"; break; }; done
sleep 4
$2
sleep 600
EOF
  mkdir -p "$work/$tag-suite"
  mv "$work/$tag-suite-run-all.sh" "$work/$tag-suite/run-all.sh"
}
wait_product() {
  local n=0
  while [ ! -f "$work/$1.product.pid" ] && [ "$n" -lt 900 ]; do sleep 0.2; n=$((n + 1)); done
  [ -f "$work/$1.product.pid" ]
}
tree_of() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do printf '%s ' "$p"; tree_of "$p"; done; }

echo "§1 a proof run stopped mid-capture whose engine the prover's wall has killed: the suite wall leaves no mercury process of the run"
make_run wall 'read -r p <"'"$work"'/wall.product.pid"; kill -STOP "$p"; kill -TERM "$engine"'
bash "$helper" "$work/wall-suite/run-all.sh" "$(awk -v s="$scale" 'BEGIN{printf "%d", 45*s}')" "$work/out" >/dev/null 2>&1 &
runner=$!
if wait_product wall; then
  read -r product <"$work/wall.product.pid"
  snapshot="$product $(tree_of "$product")"
  echo "  the run's product $product booted with children [$(tree_of "$product")]"
else
  echo "  ✗ the product never booted"; fail=1
fi
wait "$runner" 2>/dev/null
sleep 2
left=$(run_processes)
if [ -f "$work/out/wall-suite.hang" ] && [ -z "$left" ]; then echo "  ✓ the wall fired and no mercury process of the run is alive"; else echo "  ✗ after the wall (fired: $([ -f "$work/out/wall-suite.hang" ] && echo yes || echo no)) these remain: $(describe "$left")"; fail=1; fi
grep -a 'process ledger: ended' "$work/out/wall-suite.out" 2>/dev/null | sed 's/^/    /'
for p in $left; do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done

echo "§2 a proof run whose suite unit is killed outright: no mercury process of the run is alive ten seconds later"
snapshot=""
make_run killed 'true'
bash "$helper" "$work/killed-suite/run-all.sh" "$(awk -v s="$scale" 'BEGIN{printf "%d", 600*s}')" "$work/out" >/dev/null 2>&1 &
runner=$!
if wait_product killed; then
  read -r product <"$work/killed.product.pid"
  snapshot="$product $(tree_of "$product")"
  echo "  the run's product $product booted with children [$(tree_of "$product")]"
  sleep 3
  kill -9 "$runner" 2>/dev/null
  wait "$runner" 2>/dev/null
  sleep "$(awk -v s="$scale" 'BEGIN{printf "%d", 10*s}')"
  left=$(run_processes)
  if [ -z "$left" ]; then echo "  ✓ the run's product and its children are gone"; else echo "  ✗ these remain: $(describe "$left")"; fail=1; fi
  read -r epid <"$work/killed.engine.pid" 2>/dev/null || epid=""
  [ -n "$epid" ] && ! kill -0 "$epid" 2>/dev/null && echo "  ✓ the engine itself is gone"
else
  echo "  ✗ the product never booted"; fail=1
fi
for p in $(run_processes); do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done
pkill -9 -f "$work/killed-suite/run-all.sh" 2>/dev/null

if [ "$fail" = 0 ]; then echo "PASS killed-run-leaves-none — a killed run leaves no mercury process behind"; else echo "FAIL killed-run-leaves-none"; fi
exit "$fail"
