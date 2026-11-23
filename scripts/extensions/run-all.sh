#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/extensions/** src/integrations/event-hooks/** src/integrations/extensions/**
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: scripts/ui/renderScenarios.ts scripts/ui/vshot.py
# gate-watch: src/integrations/mcp/*
# gate-watch: src/integrations/skills/*
# gate-watch: src/screen/extensions/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/extensions"
fail=0
echo "############################################################"
echo "# extensions — proof suite"
echo "############################################################"
drive_members extensions 'scripts/extensions/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EXTENSIONS PROOFS PASS"; else echo "# ❌ SOME EXTENSIONS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
