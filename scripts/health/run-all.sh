#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/cli/healthJson* src/services/dap/dapClient* src/services/run/ownerLifecycle*
# gate-watch: src/substrate/startupMenu* src/utils/**
# /health certificate — proof harness (docs/HEALTH-CERTIFICATE.md).
# Runs every scripts/health/prove-*.ts via bun run; non-zero exit on any
# failure. New proofs are picked up by the glob; the suite itself auto-joins
# the green gate via scripts/run-all-suites.sh's scripts/*/run-all.sh glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# A proof never touches the operator's OS keychain: every certificate boot
# below runs on the file-backed credential store (the one rule every
# keychain spawn honours). The pooled gate pins the same; this covers a
# suite run by hand.
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
echo "############################################################"
echo "# /health certificate — proof harness"
echo "############################################################"
shopt -s nullglob
# Provers named by a sibling member list (scripts/health-*/members.txt) run in
# that sibling suite — the real-terminal drives — never here.
claimed=$(cat scripts/health-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL HEALTH PROOFS PASS"; else echo "# ❌ SOME HEALTH PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
