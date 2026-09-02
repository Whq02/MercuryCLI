#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/cockpit/repoSurfaceMap*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Fast onboarding"
echo "############################################################"
__t=$SECONDS; "$BUN" run "$here/prove-repo-surface-map.ts" || fail=1; prover_mark "$here/prove-repo-surface-map.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ONBOARDING PASS"; else echo "# ❌ ONBOARDING FAILED"; fi
echo "############################################################"
exit "$fail"
