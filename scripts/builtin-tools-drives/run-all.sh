#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/**
# gate-watch: scripts/builtin-tools/prove-git-spawn-settings.ts scripts/tool-economy/fixtures/definition-corpus.json
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/*
# gate-watch: scripts/crew/crew-world.ts
# gate-watch: package.json scripts/identity/forbidden-file-tool.ts
# gate-watch: scripts/project-services/fixtures/inventory.json scripts/provider-compat/prove-tool-call-gate.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export UI_RENDER=1
here="scripts/builtin-tools-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'builtin-tools-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members builtin-tools-drives 'scripts/builtin-tools/$name' "$here/members.txt"
