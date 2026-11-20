#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/effort*
# gate-watch: src/tools/**
# gate-watch: src/components/messages/nullRenderingAttachments.ts
# gate-watch: src/services/resources/contracts.ts
# gate-watch: src/services/attachments/orchestrator.ts
# gate-watch: src/utils/messages/attachmentText.ts
# gate-watch: src/services/lsp/**
# gate-watch: src/rows/* src/runner/wire/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/prompt"
fail=0
echo "############################################################"
echo "# prompt-composer floors — proof harness"
echo "############################################################"
drive_members prompt 'scripts/prompt/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROMPT PROOFS PASS"; else echo "# ❌ SOME PROMPT PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
