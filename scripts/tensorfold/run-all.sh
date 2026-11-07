#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/tensorfold/** src/commands/tensorfold/** src/commands.ts src/services/localSetup/setupProve.ts
# gate-watch: scripts/tensorfold/fixtures/** scripts/lib/settingsPopupHarness.ts scripts/lib/hermetic.ts
# gate-watch: src/services/projectServices/serviceManager.ts src/services/localServer/localWindowFit.ts src/utils/model/seatReceipts.ts
# gate-watch: src/components/design-system/ThemeProvider.tsx src/ink.ts src/state/AppState.tsx src/utils/config.ts src/services/providers/local/localDiscovery.ts
# gate-watch: src/components/MercuryModelPicker.tsx src/components/tensorfold/** src/utils/model/modelPickerGroups.ts src/utils/model/modelPickerFooter.ts scripts/ui/gridToPng.ts
# gate-watch: src/services/providers/local/tensorfoldHosts.ts src/services/providers/local/tensorfoldKeyFile.ts src/services/providers/local/tensorfoldApp.ts src/services/providers/local/tensorfoldHelper.ts src/services/lan/pairing.ts src/services/host/tensorfoldPod.ts src/services/host/tensorfoldRelease.ts
# gate-watch: src/services/providers/local/tensorfoldHealth.ts src/services/providers/local/tensorfoldState.ts src/services/providers/local/tensorfoldSupport.ts src/constants/localPromptProfile.ts src/services/host/recipes.ts src/entrypoints/tensorfoldAdapter.ts src/daemon/ownerWatch.ts src/utils/archive/zip.ts
# gate-watch: src/services/host/bank.ts src/substrate/splashHandover.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/tensorfold"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="[redacted]"
shopt -s nullglob
claimed=$(cat scripts/tensorfold-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
if [ "$fail" -eq 0 ]; then echo "TENSORFOLD SUITE GREEN"; else echo "TENSORFOLD SUITE RED"; fi
exit "$fail"
