#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/platform/config/**
# gate-watch: src/screen/cockpit/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/critters"
fail=0

drive_members critters 'scripts/critters/$name' "$here/members.txt" '' run || fail=1

[ "$fail" -eq 0 ] && echo "✅ critters — hero-art integrity + persistent-hero + gaze + accent-epoch + sleep/flow contracts hold"
exit "$fail"
