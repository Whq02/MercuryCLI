#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/release/** .github/workflows/private-release.yml
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# release — the release job on a machine of our own"
echo "############################################################"
for prover in "$here"/prove-*.ts; do
  [ -e "$prover" ] || continue
  run_proof "$prover" "$bun" run "$prover" || fail=1
done
if [ "$fail" -ne 0 ]; then
  echo "release suite: RED"
  exit 1
fi
echo "release suite: green"
