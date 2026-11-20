#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/TestTool/* src/tools/BashTool/* src/services/ide/projectRunners.ts
# gate-watch: src/tools/ToolSearchTool/** src/utils/model/capabilities*
# gate-watch: src/types/message.ts src/utils/attachments/types.ts
# gate-watch: src/run-core/turn/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/tool-economy"
fail=0
echo "############################################################"
echo "# tool-economy — prefix instrument · route-independent deferral laws"
echo "############################################################"
drive_members tool-economy 'scripts/tool-economy/$name' "$here/members.txt" || fail=1
exit "$fail"
