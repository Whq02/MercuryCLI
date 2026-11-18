#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_BROWSER_CACHE_DIR
# gate-watch: src/tools/DocumentTool/** vendor/pdfjs.lock.json
# gate-watch: src/skills/bundled/research* src/skills/bundled/index.ts bun.lock
# gate-watch: src/utils/permissions/filesystem.ts
# gate-watch: vendor/document-licences/** build.ts
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
