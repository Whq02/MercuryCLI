#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/dispatchDrain*
# gate-watch: src/substrate/routerRunStore* src/tools/SendMessageTool/SendMessageTool*
# gate-watch: src/utils/model/** src/utils/router/**
# gate-watch: src/utils/swarm/busEnvelopes* src/utils/teammateMailbox*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_state="$(mktemp -d "${TMPDIR:-/tmp}/router-proof-state.XXXXXX")"
export MERCURY_ROUTER_STATE_DIR="$scratch_state"
trap 'rm -rf "$scratch_state"' EXIT
echo "############################################################"
echo "# Router fabric — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL ROUTER PROOFS PASS"; else echo "# ❌ SOME ROUTER PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
