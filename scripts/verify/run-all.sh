#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/verify/** src/utils/verification/**
# gate-watch: .githooks/** scripts/gate/ledger.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# verification evidence model — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  run_proof "$proof" "$bun" run "$proof" || fail=1
done
echo
echo ">>> prove-pre-push-guard.sh"
run_proof "$here/prove-pre-push-guard.sh" bash "$here/prove-pre-push-guard.sh" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL VERIFY PROOFS PASS"; else echo "# ❌ SOME VERIFY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
