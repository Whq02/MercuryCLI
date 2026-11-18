#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/Tool* src/ink/** src/services/changeTransaction/contracts*
# gate-watch: src/services/gitGraph/** src/utils/git/spawnArgs* scripts/builtin-tools/prove-git-spawn-settings.ts scripts/tool-economy/fixtures/definition-corpus.json src/services/changeTransaction/changeSetCommit.ts
# gate-watch: src/services/journeys/runner* src/services/primitives/**
# gate-watch: src/services/resources/adapters/** src/services/resources/registry* src/services/resources/contracts.ts
# gate-watch: src/services/run/resolveOwner* src/services/structure/** src/substrate/flagRegistry*
# gate-watch: src/tools/** src/utils/capability/** src/utils/blender/bridgeGates.ts
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* src/bootstrap/state.ts
# gate-watch: src/services/api/** src/services/providers/** src/tools.ts src/utils/*
# gate-watch: src/utils/config/globalConfig.ts src/utils/messages/** src/utils/model/model.ts
# gate-watch: src/constants/tools.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/components/mercury-ui/toolGlyphs.ts src/utils/hooks/sessionHooks.ts
# gate-watch: src/utils/permissions/** src/utils/settings/permissionValidation.ts scripts/crew/crew-world.ts
# gate-watch: package.json scripts/identity/forbidden-file-tool.ts src/services/tools/toolExecution.ts
# gate-watch: scripts/project-services/fixtures/inventory.json scripts/provider-compat/prove-tool-call-gate.ts
# gate-watch: src/guards/**
# gate-watch: src/services/search/htmlText.ts src/services/search/searchPacing.ts
# gate-watch: src/services/run/ownerKey.ts src/state/AppStateStore.ts
# gate-watch: src/commands/swarm/swarm.ts
# gate-watch: src/tools/BashTool/BashTool.tsx src/tools/BashTool/prompt.ts src/tools/BashTool/webContent.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export UI_RENDER=1
here="scripts/ide-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'ide-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members ide-drives 'scripts/ide/$name' "$here/members.txt"
