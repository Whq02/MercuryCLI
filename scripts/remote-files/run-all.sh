#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/remoteFiles/**
# gate-watch: src/tools/FileReadTool/**
# gate-watch: src/tools/FileWriteTool/**
# gate-watch: src/tools/GlobTool/**
# gate-watch: src/tools/GrepTool/**
# gate-watch: src/utils/glob.ts
# gate-watch: src/utils/globPattern.ts
# gate-watch: src/components/permissions/FilePermissionDialog/**
# gate-watch: src/components/permissions/FileWritePermissionRequest/**
# gate-watch: src/components/FileEditToolDiff.tsx
# gate-watch: src/components/FileEditToolUseRejectedMessage.tsx
# gate-watch: src/components/permissions/RemotePathSubtitle.tsx
# gate-watch: src/tools/FileEditTool/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/remote-files"
fail=0
drive_members remote-files 'scripts/remote-files/$name' "$here/members.txt" || fail=1
exit $fail
