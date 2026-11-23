#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/boot/entrypoints/cli.tsx src/boot/entrypoints/init.ts src/boot/entrypoints/projectRoot.ts src/boot/entrypoints/shellParentGuard.ts src/boot/entrypoints/tensorfoldAdapter.ts src/integrations/mcp/mcpServer.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/orphans"
fail=0
drive_members orphans 'scripts/orphans/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ ORPHANS SUITE GREEN"; exit 0; else
  echo "❌ ORPHANS SUITE RED"; exit 1; fi
