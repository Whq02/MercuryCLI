#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/harness-profiles/**
# gate-watch: src/services/mission/harnessProfiles.ts src/services/mission/policyProfiles.ts
# gate-watch: src/services/mission/harnessApplication.ts src/substrate/flagRegistry.ts
# gate-watch: src/utils/profile/mercuryProfile.ts src/utils/model/modelTransition.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/harness-profiles/prove-*.ts; do
  echo "── harness-profiles: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
