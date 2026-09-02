#!/usr/bin/env bash
# gate-class: pty
# (this suite drives the BUILT dist through vshot (real PTY product boots); the class annotation lives on this line: the gate registry parses the header line as the bare class)
# gate-watch: scripts/verify/** src/utils/verification/**
# gate-watch: .githooks/** scripts/gate/ledger.ts
# scripts/verify/run-all.sh — the mutation→verification evidence model
# (Sol 5.6 WS5). Auto-joins the green gate via the scripts/*/run-all.sh glob.
set -u
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
  "$bun" run "$proof" || fail=1
done
echo
echo ">>> prove-pre-push-guard.sh"
bash "$here/prove-pre-push-guard.sh" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL VERIFY PROOFS PASS"; else echo "# ❌ SOME VERIFY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
