#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/wardsHook* src/utils/markdownConfigLoader* src/utils/projectConfig*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_state="$(mktemp -d "${TMPDIR:-/tmp}/projectdirs-proof.XXXXXX")"
export MERCURY_PROJECTDIRS_UNUSED="$scratch_state"
trap 'rm -rf "$scratch_state"' EXIT
echo "############################################################"
echo "# dual project-config — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROJECTDIRS PROOFS PASS"; else echo "# ❌ SOME PROJECTDIRS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
