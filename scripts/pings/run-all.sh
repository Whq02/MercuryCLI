#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
# gate-watch: scripts/lib/fixtureApi.ts
# gate-watch: scripts/streaming/artifactArena.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/pings"
fail=0

echo "############################################################"
echo "# pings — one ping when a chat finishes its turn while you are away"
echo "############################################################"

drive_members pings 'scripts/pings/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ pings PASS"; else echo "# ❌ pings FAILED"; fi
echo "############################################################"
exit "$fail"
