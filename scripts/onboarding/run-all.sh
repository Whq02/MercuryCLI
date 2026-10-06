#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/Onboarding.tsx src/components/loginFamilyRows.ts src/components/ConsoleOAuthFlow.tsx src/services/providers/providerUsability.ts scripts/lib/settingsPopupHarness.ts src/keybindings/KeybindingProviderSetup.tsx src/state/AppState.tsx src/utils/config.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Fast onboarding"
echo "############################################################"
__t=$SECONDS; __rc=0; "$BUN" run "$here/prove-first-run-stations.tsx" || { __rc=$?; fail=1; }; prover_mark "$here/prove-first-run-stations.tsx" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ONBOARDING PASS"; else echo "# ❌ ONBOARDING FAILED"; fi
echo "############################################################"
exit "$fail"
