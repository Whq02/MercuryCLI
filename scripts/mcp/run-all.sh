#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_PROOF_DIST
# gate-watch: src/commands/mcp/* src/daemon/runner/*
# gate-watch: src/engine/attachment-shapes/attachmentTypes.ts src/engine/message-shapes/message.ts
# gate-watch: src/engine/rows/*
# gate-watch: src/integrations/mcp/** src/platform/health/readiness.ts
# gate-watch: src/platform/settings/projectConfig.ts
# gate-watch: sdk/src/** src/screen/mcp/* src/screen/renderer/elements/TerminalSizeContext.tsx
# gate-watch: src/screen/renderer/staticRender.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mcp"
fail=0
echo "############################################################"
echo "# MCP hardening — proof harness"
echo "############################################################"
drive_members mcp 'scripts/mcp/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MCP PROOFS PASS"; else echo "# ❌ SOME MCP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
