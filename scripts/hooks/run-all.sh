#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/**
# gate-watch: src/cli/run.ts src/schemas/hooks.ts
# gate-watch: src/components/hooks/** src/components/messages/AttachmentMessage.tsx
# gate-watch: src/fabric/entryCodec.ts src/hooks/useSkillsChange.ts src/utils/*
# gate-watch: src/utils/sessionStorage/chain.ts
# gate-watch: src/utils/sessionStorage/paths.ts
# gate-watch: src/rows/turn.ts src/Tool.ts src/query.ts src/run-core/**
# gate-watch: src/utils/messages/turnCut.ts src/utils/settings/types.ts
# gate-watch: src/guards/**
# gate-watch: src/rows/project.ts
# gate-watch: src/utils/sessionStorage/rowGraph.ts src/utils/sessionStorage/transcriptReader.ts
# gate-watch: src/components/Messages.tsx src/tools.ts
# gate-watch: src/services/settings/faultNotices.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/hooks"
fail=0
echo "── hooks proofs ──"
drive_members hooks 'scripts/hooks/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ HOOKS SUITE GREEN"; exit 0; else
  echo "❌ HOOKS SUITE RED"; exit 1; fi
