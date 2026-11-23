#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/permissions/cards/RemotePathSubtitle.tsx
# gate-watch: src/permissions/cards/file-dialog/**
# gate-watch: src/permissions/cards/file-write/**
# gate-watch: src/platform/remote-files/**
# gate-watch: src/tools/edit/**
# gate-watch: src/tools/glob/**
# gate-watch: src/tools/grep/**
# gate-watch: src/tools/read/**
# gate-watch: src/tools/write/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/remote-files"
fail=0
drive_members remote-files 'scripts/remote-files/$name' "$here/members.txt" || fail=1
exit $fail
