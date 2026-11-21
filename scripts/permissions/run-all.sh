#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/** src/utils/messages/streaming*
# gate-watch: src/constants/prompts*
# gate-watch: scripts/api/read-instruction-heading.ts
# gate-watch: src/cli/structuredIO.ts
# gate-watch: src/services/instructions/projectInstructionWriter.ts src/services/lsp/** src/services/mcp/** src/services/providers/**
# gate-watch: src/utils/bash/parser.ts src/utils/bash/bashParser.ts src/utils/bash/ParsedCommand.ts src/utils/bash/treeSitterAnalysis.ts
# gate-watch: src/utils/config/**
# gate-watch: src/utils/errors.ts
# gate-watch: src/services/health/healthReport.ts src/utils/permissions/**
# gate-watch: src/utils/settings/**
# gate-watch: src/rows/*
# gate-watch: src/utils/windowsPaths.ts
# gate-watch: src/guards/** src/utils/artifactIdentity.ts src/utils/genericProcessUtils.ts src/cli/update.ts
# gate-watch: src/services/remoteFiles/**
# gate-watch: src/utils/shell/engineSession.ts
# gate-watch: src/cli/headless/*
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
