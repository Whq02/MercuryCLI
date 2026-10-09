#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/distribution/**
# gate-watch: THIRD_PARTY_NOTICES.md package.json bun.lock vendor/*.lock.json
# gate-watch: LICENSE.md TRADEMARKS.md MERCURY-COMMUNITY-PRODUCTION-TERMS.md scripts/release/releaseDocuments.mjs scripts/release/payloadContract.mjs
# gate-watch: .github/workflows/private-release.yml README.md build.ts docs/COMPATIBILITY.md docs/README.md
# gate-watch: scripts/release/package.mjs scripts/release/verifyArchive.mjs src/constants/legalNotice.ts
# gate-watch: src/utils/crashReport.ts
# gate-watch: Dockerfile .dockerignore bunfig.toml src/services/privateChannel/vendoredRuntime.ts src/services/providers/credentialEnvSpellings.ts scripts/lib/fixtureApi.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
claimed=$(cat "$here"/../distribution-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
echo "############################################################"
echo "# distribution — ownership record + distribution readiness"
echo "############################################################"
for prover in "$here"/prove-*.ts; do
  [ -e "$prover" ] || continue
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$prover")"; then
    echo "· $(basename "$prover") runs with the distribution drives (scripts/distribution-drives/members.txt)"
    continue
  fi
  run_proof "$prover" "$bun" run "$prover" || fail=1
done
if [ "$fail" -ne 0 ]; then
  echo "distribution suite: RED"
  exit 1
fi
echo "distribution suite: green"
