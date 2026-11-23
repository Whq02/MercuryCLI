#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner-wire/*
# gate-watch: src/engine/connector/seatLive.ts
# gate-watch: src/engine/message-shapes/message.ts src/engine/rows/*
# gate-watch: src/models/facts/pins/* src/models/roads/**
# gate-watch: src/platform/health/healthReport.ts src/platform/settings/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/provider-compat"
fail=0
echo "############################################################"
echo "# provider-compat — multi-provider proof harness"
echo "############################################################"
echo "# Engine request contracts: prove-engine-shapes.ts and prove-tool-schemas-no-refs.ts"
drive_members provider-compat 'scripts/provider-compat/$name' "$here/members.txt" || fail=1
exit "$fail"
