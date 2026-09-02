#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/providerUsability* src/services/providers/providerUsage*
# gate-watch: src/services/providers/accountSlots* src/components/ConsoleOAuthFlow*
# gate-watch: src/services/providers/sseDecoder*
# ============================================================================
#  scripts/providers/run-all.sh — the provider readiness/usage/slot proof
#  suite (spec-05 estate): hermetic resolvers over injected read bundles.
#  Globs prove-*.ts; auto-joins the pool via scripts/run-all-suites.sh.
# ============================================================================
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# providers — readiness · usage truth · slot health"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit "$fail"
