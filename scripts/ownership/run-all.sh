#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/boot/main.tsx src/crew/crew-start/** src/daemon/runner-wire/* src/daemon/runner/** src/engine/compaction/**
# gate-watch: src/engine/loop/** src/engine/message-shapes/message.ts src/engine/rows/* src/engine/run-owner/*
# gate-watch: src/engine/tool-dispatch/** src/engine/turnDoor.ts src/integrations/mcp/** src/permissions/rules/** src/platform/settings/** src/screen/chat/Chat.tsx
# gate-watch: src/screen/composer/** src/tools/crewmate/* src/tools/document/DocumentTool.ts src/tools/document/schema.ts
# gate-watch: scripts/lib/* scripts/verify/impactManifest.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ownership"
fail=0
echo "############################################################"
echo "# ownership — core-ownership contract + journey harness"
echo "############################################################"
drive_members ownership 'scripts/ownership/$name' "$here/members.txt" || fail=1
exit $fail
