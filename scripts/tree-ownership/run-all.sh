#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/projectConfig* src/substrate/flagRegistry*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
command -v "$bun" >/dev/null 2>&1 || bun=bun
fail=0
echo "############################################################"
echo "# tree-ownership — §13 native-ownership proofs"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL tree-ownership PROOFS PASS"; else echo "# ❌ SOME tree-ownership PROOFS FAILED"; fi
exit "$fail"
