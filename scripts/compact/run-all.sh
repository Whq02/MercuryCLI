#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
# gate-watch: scripts/lib/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/compact"
fail=0
echo "############################################################"
echo "# compact — context maintenance proofs"
echo "############################################################"
drive_members compact 'scripts/compact/$name' "$here/members.txt" || fail=1
exit "$fail"
