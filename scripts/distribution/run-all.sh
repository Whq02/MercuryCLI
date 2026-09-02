#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/distribution/**
# gate-watch: THIRD_PARTY_NOTICES.md package.json bun.lock vendor/*.lock.json
# ============================================================================
#  scripts/distribution/run-all.sh — the suite: the
#  evidence-backed ownership record (schema 2), the origin index, and the
#  distribution-readiness checks. Globs prove-*.ts so later
#  provers auto-join; the suite auto-joins the green gate via
#  scripts/run-all-suites.sh's scripts/*/run-all.sh glob.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# distribution — ownership record + distribution readiness"
echo "############################################################"
for prover in "$here"/prove-*.ts; do
  [ -e "$prover" ] || continue
  "$bun" run "$prover" || fail=1
done
if [ "$fail" -ne 0 ]; then
  echo "distribution suite: RED"
  exit 1
fi
echo "distribution suite: green"
