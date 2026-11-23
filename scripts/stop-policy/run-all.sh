#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner-wire/*
# gate-watch: src/daemon/runner/*
# gate-watch: src/engine/loop/turn/** src/engine/rows/*
# gate-watch: src/engine/run/** src/engine/turn-entry/* src/integrations/event-hooks/fire.ts
# gate-watch: src/permissions/guards/**
# gate-watch: src/platform/health/healthReport.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/stop-policy"
fail=0

echo "############################################################"
echo "# stop-policy — evidence-gated persistence proof harness"
echo "############################################################"
drive_members stop-policy 'scripts/stop-policy/$name' "$here/members.txt" || fail=1
exit $fail
