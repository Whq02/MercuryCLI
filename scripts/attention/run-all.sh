#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/attention/** src/services/workbench/** src/input-core/**
# gate-watch: src/services/acp/** src/components/tasks/**
# gate-watch: integrations/acp/README.md
# gate-watch: scripts/streaming/bench-stream-fluidity.ts
# gate-watch: src/bootstrap/state.ts
# gate-watch: src/components/PromptInput/PromptInput.tsx src/components/mercury-ui/*
# gate-watch: src/tools.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/attention"
fail=0

echo "############################################################"
echo "# attention — the operator command surface"
echo "############################################################"

drive_members attention 'scripts/attention/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ attention PASS"; else echo "# ❌ attention FAILED"; fi
echo "############################################################"
exit "$fail"
