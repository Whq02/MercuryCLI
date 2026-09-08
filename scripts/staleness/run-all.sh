#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/staleness/**
# gate-watch: src/services/switchboard/harnessGround.ts src/utils/settings/changeDetector.ts
# gate-watch: src/utils/config/projectConfig.ts src/ink/session/windowsHostSetup.ts
# gate-watch: src/utils/router/providerDiscovery.ts src/services/switchboard/capacityCheck.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
for prover in scripts/staleness/prove-*.ts; do
  start=$SECONDS
  if ! { "$bun" "$prover"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "❌ $prover"
    failed=1
  fi
  prover_mark "$prover" "$start" "$__rc"
done

if [ "$failed" -eq 0 ]; then
  echo "staleness: PASS"
else
  echo "staleness: FAIL"
fi
exit "$failed"
