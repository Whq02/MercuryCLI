#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/sessionHooks*
# gate-watch: src/utils/* src/utils/hooks/fire.ts src/guards/**
# gate-watch: src/skills/bundled/**
# gate-watch: src/utils/bash/parser.ts
# gate-watch: src/utils/permissions/runtimeProtection.ts src/utils/permissions/protectedPaths.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# wards — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL WARDS PROOFS PASS"; else echo "# ❌ SOME WARDS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
