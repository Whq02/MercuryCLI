#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/Tool* src/ink/** src/services/changeTransaction/contracts*
# gate-watch: src/services/gitGraph/observe* src/services/gitGraph/plan*
# gate-watch: src/services/journeys/runner* src/services/primitives/**
# gate-watch: src/services/resources/adapters/** src/services/resources/registry*
# gate-watch: src/services/run/resolveOwner* src/services/structure/** src/substrate/flagRegistry*
# gate-watch: src/tools/** src/utils/capability/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# builtin-tools — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
echo ">>> render-builtin-tools-cards.tsx (capability cards, real PTY grid)"
__t=$SECONDS; __rc=0; UI_RENDER=1 "$bun" run "$here"/render-builtin-tools-cards.tsx || { __rc=$?; fail=1; }; prover_mark "$here"/render-builtin-tools-cards.tsx "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL builtin-tools PROOFS PASS"; else echo "# ❌ SOME builtin-tools PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
