#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/sessions/project-intel/**
# gate-watch: src/screen/cockpit/repoSurfaceMap.ts
# gate-watch: src/commands/orient/orient.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/project-intel"
fail=0
echo "############################################################"
echo "# Project intelligence — proof suite"
echo "############################################################"
[ -f "$here/prove-path-tokens-linear.ts" ] || { printf '%s\n' 'Missing required proof: prove-path-tokens-linear.ts' >&2; exit 1; }
drive_members project-intel 'scripts/project-intel/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROJECT-INTEL PROOFS PASS"; else echo "# ❌ SOME PROJECT-INTEL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
