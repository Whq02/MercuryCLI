#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/tool-errors/**
# gate-watch: src/permissions/rules/*
# gate-watch: src/platform/shell/bash/bashParser.ts src/platform/shell/bash/commands.ts src/platform/shell/bash/parsedCommand.ts src/platform/shell/bash/treeSitterAnalysis.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/decisions"
fail=0
echo "############################################################"
echo "# decisions — permission decision-chain proof harness"
echo "############################################################"
drive_members decisions 'scripts/decisions/$name' "$here/members.txt" || fail=1
exit $fail
