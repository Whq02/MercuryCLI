#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/consistency-census/** src/constants/systemPromptSections.ts
# gate-watch: src/utils/worktree.ts src/utils/cache/cacheClock.ts scripts/release/payloadContract.mjs
# gate-watch: scripts/lib/git.ts scripts/lib/executionProfile.ts scripts/lib/captureDriver.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/consistency-census/prove-*.ts; do
  echo "── consistency-census: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
