#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/errors/**
# gate-watch: src/utils/permissions/permissions*
# gate-watch: src/utils/bash/bashParser.ts src/utils/bash/commands.ts src/utils/bash/ParsedCommand.ts src/utils/bash/treeSitterAnalysis.ts
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
