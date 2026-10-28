#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/document/** src/tools/DocumentTool/** vendor/document-libs.lock.json
# gate-watch: src/skills/bundled/research* src/skills/bundled/index.ts src/tools.ts package.json bun.lock
# gate-watch: src/utils/permissions/filesystem.ts src/services/browser/browserResolver.ts
# gate-watch: scripts/vendor/documentLibraries.ts vendor/document-licences/** mercury-skills/research/** build.ts
# gate-watch: scripts/lib/hermetic.ts scripts/ast-tools/lib/harness.ts src/Tool.ts src/bootstrap/state.ts
# gate-watch: src/services/changeTransaction/receipts.ts src/tools/ToolSearchTool/prompt.ts
# gate-watch: src/services/browser/browserSession.ts src/services/run/ownerKey.ts
# gate-watch: src/skills/bundled/research/** src/skills/bundledSkills.ts src/utils/execFileNoThrow.ts src/utils/which.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
trap suite_home_cleanup EXIT
fail=0
for proof in "$(dirname "$0")"/prove-*.ts; do
  start=$SECONDS
  rc=0
  "${BUN:-bun}" "$proof" || rc=$?
  printf '%s %ss rc=%s\n' "$proof" "$((SECONDS-start))" "$rc"
  [ "$rc" -eq 0 ] || fail=1
done
exit "$fail"
