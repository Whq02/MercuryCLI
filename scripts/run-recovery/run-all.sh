#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/run-core/** src/services/run/** src/substrate/** src/services/primitives/**
# gate-watch: src/cli/headless/** src/utils/pulse/** src/utils/sessionStorage/** src/query.ts
# gate-watch: src/utils/sessionRestore.ts src/utils/conversationRecovery.ts src/utils/toolResultSummary.ts src/utils/cockpit/awaySummary.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# MERCURY run-recovery — cross-domain integration lane"
echo "############################################################"

shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$BUN" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ run-recovery SUITE OK"; else echo "# ❌ run-recovery SUITE FAILED"; fi
echo "############################################################"
exit "$fail"
