#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/config/** src/utils/envUtils*
# gate-watch: src/utils/secureStorage/macOsKeychainHelpers*
# gate-watch: scripts/gate/run-suite.sh scripts/lib/proofHome.ts scripts/ui/render-tui.ts
# gate-watch: scripts/ui/renderScenarios.ts src/components/mercury-ui/parity/AccountView.tsx
# gate-watch: src/daemon/controlSocket.ts src/daemon/ownedDaemon.ts src/main.tsx src/substrate/flagRegistry.ts
# gate-watch: src/utils/env.ts src/utils/healthReport.ts src/utils/processUserInput/processBashCommand.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# build-identity — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BUILD-IDENTITY PROOFS PASS"; else echo "# ❌ SOME BUILD-IDENTITY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
