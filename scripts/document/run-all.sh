#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_BROWSER_CACHE_DIR
# gate-watch: vendor/pdfjs.lock.json src/integrations/skills/bundled/index.ts
# gate-watch: bun.lock src/permissions/rules/filesystem.ts
# gate-watch: src/tools/document/**
# gate-watch: vendor/document-licences/** build.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
trap suite_home_cleanup EXIT
cd "$(dirname "$0")/../.." || exit 1
here="scripts/document"
fail=0
drive_members document 'scripts/document/$name' "$here/members.txt" || fail=1
exit "$fail"
