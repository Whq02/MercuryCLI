#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/distribution/**
# gate-watch: THIRD_PARTY_NOTICES.md package.json bun.lock vendor/*.lock.json
# gate-watch: LICENSE.md TRADEMARKS.md MERCURY-COMMUNITY-PRODUCTION-TERMS.md scripts/release/releaseDocuments.mjs scripts/release/payloadContract.mjs
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# distribution — ownership record + distribution readiness"
echo "############################################################"
for prover in "$here"/prove-*.ts; do
  [ -e "$prover" ] || continue
  run_proof "$prover" "$bun" run "$prover" || fail=1
done
if [ "$fail" -ne 0 ]; then
  echo "distribution suite: RED"
  exit 1
fi
echo "distribution suite: green"
