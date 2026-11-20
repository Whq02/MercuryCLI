#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/editor-bridge/** scripts/lib/nodeBin.ts
# gate-watch: src/services/workbench/** src/services/resources/adapters/workbench.ts
# gate-watch: src/services/acp/**
# gate-watch: src/utils/artifacts/** src/components/diff/** src/components/prompts-panel/**
# gate-watch: integrations/vscode/extension.js integrations/vscode/package.json integrations/vscode/LICENSE.txt LICENSE.md NOTICE
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/fixtureApi.ts
# gate-watch: scripts/prompts-panel/prove-panel-captures.ts scripts/release/package.mjs
# gate-watch: scripts/release/payloadContract.mjs scripts/vscode/build-vsix.sh scripts/vscode/host-test/run.sh
# gate-watch: src/cli/run.ts
# gate-watch: src/services/mcp/client.ts src/services/run/*
# gate-watch: src/utils/*
# gate-watch: scripts/idiom/prove-body-shape-registry.ts src/fabric/validate.ts
# gate-watch: src/utils/attachments/mentionResolvers.ts src/utils/attachments/types.ts
# gate-watch: src/utils/messages/attachmentText.ts
# gate-watch: src/rows/* src/runner/wire/* scripts/mcp/_fixture-estate-server.mjs src/tools/AskUserQuestionTool/**
# gate-watch: scripts/consistency-census/prove-worktree-settlement.ts
# gate-watch: scripts/lib/processGroup.ts
# gate-watch: scripts/lib/toolShellTree.ts
# gate-watch: src/services/engine-connector/midTurnText.ts src/utils/sessionStorage/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/editor-bridge-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'editor-bridge-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members editor-bridge-drives 'scripts/editor-bridge/$name' "$here/members.txt"
