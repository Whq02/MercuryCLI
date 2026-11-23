#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner-wire/*
# gate-watch: src/engine/attachments/turnAttachments.ts
# gate-watch: src/engine/messages/attachmentText.ts
# gate-watch: src/engine/rows/*
# gate-watch: src/integrations/lsp/**
# gate-watch: src/integrations/resources/contracts.ts
# gate-watch: src/models/effort/*
# gate-watch: src/screen/messages/nullRenderingAttachments.ts src/tools/**
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
