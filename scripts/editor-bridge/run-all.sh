#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
# gate-watch: LICENSE.md NOTICE
# gate-watch: scripts/idiom/prove-body-shape-registry.ts
# gate-watch: scripts/lib/ptyRecorder.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/editor-bridge"

red=0
drive_members editor-bridge 'scripts/editor-bridge/$name' "$here/members.txt" '' run || red=1

exit "$red"
