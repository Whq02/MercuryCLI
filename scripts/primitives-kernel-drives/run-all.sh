#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: src/components/mercury-ui/toolCardGrammar* src/ink/**
# gate-watch: src/services/agentResults/normalize* src/services/changeTransaction/receipts*
# gate-watch: src/services/changeTransaction/snapshotAnchor* src/services/dap/dapClient*
# gate-watch: src/services/lsp/LSPServerInstance* src/services/primitives/**
# gate-watch: src/services/projectServices/executionProjection*
# gate-watch: src/services/projectServices/serviceManager*
# gate-watch: src/services/resources/adapters/service* src/services/resources/contracts*
# gate-watch: src/services/resources/registry* src/services/run/**
# gate-watch: src/utils/task/executionProjection* src/utils/task/framework*
# gate-watch: src/utils/verification/verificationState*
# gate-watch: scripts/lib/proofHome.ts scripts/primitives-kernel/render-primitives-kernel-cards.tsx src/ink.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export UI_RENDER=1
here="scripts/primitives-kernel-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'primitives-kernel-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members primitives-kernel-drives 'scripts/primitives-kernel/$name' "$here/members.txt"
