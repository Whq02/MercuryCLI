#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/samples/** src/components/samples/** src/commands/samples/** src/components/mercury-ui/SessionTabs.tsx src/components/tasks/useFocusedWork.ts src/components/tasks/CompactWorkSummary.tsx src/components/tasks/BackgroundTasksDialog.tsx src/services/engine-connector/seatWire.ts scripts/samples-drives/prove-*.ts build.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/samples-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ samples-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi
fail=0
echo "############################################################"
echo "# samples-drives — the cockpit's samples, driven on a pty"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL samples-drives PROOFS PASS"; else echo "# ❌ SOME samples-drives PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
