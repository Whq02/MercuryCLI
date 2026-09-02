#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/mercury-ui/parity/AccountView* src/services/api/errors* src/utils/**
# ============================================================================
#  scripts/accounts/run-all.sh — the account-slots suite.
#  Pins the plain slot model (account-slot simplification, operator
#  ruling): the resolved-home scope universe, sign-in truth +
#  no-leakage, per-home keychain identity, and the retirement absences. Globs prove-*.ts so new legs
#  auto-join; the suite itself auto-joins the green gate
#  (scripts/run-all-suites.sh globs scripts/*/run-all.sh).
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# A proof never touches the operator's OS keychain: every prover and every
# child it boots runs on the file-backed credential store (the one rule
# every keychain spawn honours). The pooled gate pins the same; this covers
# a suite run by hand.
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
for f in scripts/accounts/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ ACCOUNTS SUITE GREEN"; else echo "❌ ACCOUNTS SUITE RED"; fi
exit "$fail"
