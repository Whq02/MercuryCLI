#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/verbs/update.ts src/daemon/runner/*
# gate-watch: src/engine/message-shapes/*
# gate-watch: scripts/api/read-instruction-heading.ts
# gate-watch: src/engine/rows/*
# gate-watch: src/engine/system-prompt/* src/integrations/event-hooks/** src/integrations/lsp/** src/integrations/mcp/**
# gate-watch: src/models/roads/** src/permissions/guards/** src/permissions/rules/** src/platform/config/**
# gate-watch: src/platform/errors/errors.ts
# gate-watch: src/platform/files/windowsPaths.ts
# gate-watch: src/platform/health/healthReport.ts src/platform/processes/processLiveness.ts
# gate-watch: src/platform/product/artifactIdentity.ts
# gate-watch: src/platform/remote-files/**
# gate-watch: src/platform/settings/**
# gate-watch: src/platform/shell/bash/bashParser.ts src/platform/shell/bash/parsedCommand.ts src/platform/shell/bash/parser.ts src/platform/shell/bash/treeSitterAnalysis.ts
# gate-watch: src/platform/shell/engineSession.ts
# gate-watch: src/screen/messages-list/*
# gate-watch: src/sessions/instructions/projectInstructionWriter.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/permissions"
fail=0
echo "############################################################"
echo "# Permission ladder / flow — proof suite"
echo "############################################################"
drive_members permissions 'scripts/permissions/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PERMISSION PROOFS PASS"; else echo "# ❌ SOME PERMISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
