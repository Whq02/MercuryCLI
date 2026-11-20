#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_PROOF_DIST
# gate-watch: src/services/mcp/** src/utils/Shell*
# gate-watch: src/commands/mcp/* src/components/mcp/*
# gate-watch: src/utils/projectConfig.ts
# gate-watch: src/utils/staticRender.tsx src/ink/components/TerminalSizeContext.tsx
# gate-watch: src/utils/readiness.ts
# gate-watch: src/rows/* sdk/src/** src/cli/headless/projectQuery.ts
# gate-watch: src/types/message.ts src/utils/attachments/types.ts
# gate-watch: src/cli/headless/*
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
