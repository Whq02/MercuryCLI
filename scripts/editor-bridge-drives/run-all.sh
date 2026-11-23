#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/editor-bridge/** scripts/lib/nodeBin.ts
# gate-watch: src/**
# gate-watch: integrations/vscode/extension.js integrations/vscode/package.json integrations/vscode/LICENSE.txt LICENSE.md NOTICE
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/fixtureApi.ts
# gate-watch: scripts/prompts-panel/prove-panel-captures.ts scripts/release/package.mjs
# gate-watch: scripts/release/payloadContract.mjs scripts/vscode/build-vsix.sh scripts/vscode/host-test/run.sh
# gate-watch: scripts/idiom/prove-body-shape-registry.ts
# gate-watch: scripts/mcp/_fixture-estate-server.mjs
# gate-watch: scripts/consistency-census/prove-worktree-settlement.ts
# gate-watch: scripts/lib/processGroup.ts
# gate-watch: scripts/lib/toolShellTree.ts
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
