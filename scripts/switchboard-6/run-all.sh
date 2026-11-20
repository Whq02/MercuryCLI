#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/**
# gate-watch: src/services/concourse/** src/components/concourse/**
# gate-watch: src/services/switchboard/attachedSession.ts
# gate-watch: src/constants/prompts.ts
# gate-watch: src/screens/chat/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-6"

failed=0
drive_members switchboard-6 'scripts/switchboard/$name' "$here/members.txt" || failed=1

exit "$failed"
