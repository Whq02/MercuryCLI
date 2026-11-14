#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/remoteFiles/**
# gate-watch: scripts/lib/removeScratch.ts
# gate-watch: scripts/lib/fixtureApi.ts
# gate-watch: scripts/lib/firstRunSeed.ts
# gate-watch: src/services/changeTransaction/seenLines.ts
# gate-watch: src/utils/readFileInRange.ts
# gate-watch: src/utils/file.ts
# gate-watch: src/components/FilePathLink.tsx
# gate-watch: src/utils/fileStateCache.ts
# gate-watch: src/utils/attachments/fileAttachments.ts
# gate-watch: src/Tool.ts
# gate-watch: src/bootstrap/state.ts
# gate-watch: src/utils/config/globalConfig.ts
# gate-watch: src/tools/FileReadTool/**
# gate-watch: src/tools/FileWriteTool/**
# gate-watch: src/tools/GlobTool/**
# gate-watch: src/tools/GrepTool/**
# gate-watch: src/utils/glob.ts
# gate-watch: src/utils/globPattern.ts
# gate-watch: src/components/permissions/FilePermissionDialog/**
# gate-watch: src/components/permissions/FileWritePermissionRequest/**
# gate-watch: src/components/permissions/FileEditPermissionRequest/**
# gate-watch: src/components/permissions/FilesystemPermissionRequest/**
# gate-watch: src/components/FileEditToolDiff.tsx
# gate-watch: src/components/FileEditToolUseRejectedMessage.tsx
# gate-watch: src/components/permissions/RemotePathSubtitle.tsx
# gate-watch: src/tools/FileEditTool/**
# gate-watch: src/state/AppState.tsx
# gate-watch: src/ink.ts
# gate-watch: src/components/MessageSelector.tsx
# gate-watch: src/keybindings/KeybindingProviderSetup.tsx
# gate-watch: src/services/engine-connector/focusedConnector.ts
# gate-watch: src/services/engine-connector/noSessionConnector.ts
# gate-watch: src/utils/permissions/filesystem.ts
# gate-watch: src/utils/attachments/orchestrator.ts
# gate-watch: scripts/tools/fixtures/read-formats/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
