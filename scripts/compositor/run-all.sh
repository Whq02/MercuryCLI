#!/bin/bash
# gate-class: pure
# gate-watch: src/components/*
# gate-watch: src/components/concourse/*
# gate-watch: src/ink/*
# gate-watch: src/ink/termio/*
# gate-watch: src/keybindings/*
# gate-watch: src/utils/cockpit/*
# gate-watch: src/components/HelpV2/HelpV2.tsx src/components/PromptInput/PromptInput.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/compositor"
fail=0
drive_members compositor 'scripts/compositor/$name' "$here/members.txt" '' run || fail=1

exit "$fail"
