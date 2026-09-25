#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/bootstrap/state*
# gate-watch: src/utils/settings/** src/utils/config/** src/utils/config.ts
# gate-watch: src/utils/fileRead* scripts/lib/scratchSeat.ts
# gate-watch: src/migrations/**
# gate-watch: src/components/BootSettingsScreen* src/services/switchboard/capacityCheck*
# gate-watch: src/components/Settings/** src/services/providers/providerUsage* src/commands/usage/**
# gate-watch: src/services/providers/accountSlots* src/components/mercury-ui/parity/AccountView*
# gate-watch: src/components/HelmTelemetryRail* src/components/BootLoginsScreen* src/components/BootSplashScreen* src/services/wallet/** src/utils/accounts/** src/utils/auth.ts
# gate-watch: src/cli/handlers/auth.ts src/utils/status.tsx src/state/AppState.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# settings — configuration pipeline proof harness"
echo "############################################################"
shopt -s nullglob
export TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
