#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/eval/** src/tools/EvalTool/**
# gate-watch: src/utils/router/providerSecrets* src/substrate/flagRegistry*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# eval kernels — proof harness"
echo "############################################################"
for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EVAL PROOFS PASS"; else echo "# ❌ SOME EVAL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
