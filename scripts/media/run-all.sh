#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/host/** src/commands/llmhost/words.ts vendor/node.lock.json src/commands/imagesetup/** src/components/Settings/Config.tsx src/services/localServer/localServerTruth.ts
# gate-watch: src/extensions/**
# gate-watch: src/components/permissions/PermissionRequest.tsx
# gate-watch: src/ink.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/media"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for proof in "$here"/prove-*.ts; do
  start=$SECONDS; rc=0
  "$bun" run "$proof" || { rc=$?; fail=1; }
  printf '── scripts/media/%s  %ss rc=%s\n' "$(basename "$proof")" "$(( SECONDS - start ))" "$rc"
done
exit "$fail"
