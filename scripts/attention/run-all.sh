#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/boot/process-state/* src/integrations/acp/** src/screen/attention/**
# gate-watch: src/screen/composer/Composer.tsx src/screen/composer/input-core/**
# gate-watch: integrations/acp/README.md
# gate-watch: scripts/streaming/bench-stream-fluidity.ts
# gate-watch: src/screen/tasks/**
# gate-watch: src/screen/widgets/* src/screen/workbench/**
# gate-watch: src/tools/kit/toolList.ts
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
