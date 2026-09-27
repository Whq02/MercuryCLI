#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/localSetup/** src/services/localServer/** src/services/providers/local/** scripts/lib/hermetic.ts
# gate-watch: src/commands/model/persistModelChoice.ts src/utils/model/modelTransition.ts src/utils/settings/settings.ts src/utils/config.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/local-setup"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
shopt -s nullglob
claimed=$(cat scripts/local-setup-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
if [ "$fail" -eq 0 ]; then echo "LOCAL-SETUP SUITE GREEN"; else echo "LOCAL-SETUP SUITE RED"; fi
exit "$fail"
