#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/compact/** src/services/run/**
# gate-watch: src/utils/config/** src/utils/messages/**
# gate-watch: src/components/*
# gate-watch: src/utils/*
# gate-watch: src/services/providers/local/localDiscovery.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/context"
fail=0
echo "############################################################"
echo "# context — context-lifecycle proof harness"
echo "############################################################"
drive_members context 'scripts/context/$name' "$here/members.txt" || fail=1
exit $fail
