#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_AX_KEEP MERCURY_AX_VERBOSE MERCURY_AX_DUMP_HITS
# gate-watch: src/daemon/runner-wire/* src/engine/rows/*
# gate-watch: src/engine/system-prompt/** src/tools/crewmate/* src/tools/crewmate/built-in/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/agent-experience"
fail=0
echo "############################################################"
echo "# agent-experience — the cold-start benchmark (mechanical legs)"
echo "############################################################"
drive_members agent-experience 'scripts/agent-experience/$name' "$here/members.txt" || fail=1
exit $fail
