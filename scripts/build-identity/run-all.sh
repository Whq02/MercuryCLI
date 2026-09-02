#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/config/** src/utils/envUtils*
# gate-watch: src/utils/secureStorage/macOsKeychainHelpers*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# fork seam / build-identity — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL FORK-SEAM PROOFS PASS"; else echo "# ❌ SOME FORK-SEAM PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
