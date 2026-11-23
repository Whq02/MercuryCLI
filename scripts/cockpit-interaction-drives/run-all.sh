#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/cockpit-interaction/**
# gate-watch: src/boot/** src/commands/**
# gate-watch: src/daemon/runner-wire/*
# gate-watch: src/engine/context-window/analyzeContext.ts
# gate-watch: src/engine/loop/*
# gate-watch: src/engine/messages/toolSearch.ts src/engine/rows/* src/engine/run-owner/resolveOwner.ts
# gate-watch: scripts/engine-durability/bench-prompt-attribution.ts
# gate-watch: scripts/gate/ledger.ts scripts/lib/*
# gate-watch: src/engine/user-input/** src/integrations/skills/bundled/index.ts
# gate-watch: src/integrations/skills/bundledSkills.ts
# gate-watch: src/models/roads/zai/** src/models/sign-in/**
# gate-watch: src/models/usage/**
# gate-watch: src/permissions/cards/** src/screen/** src/sessions/artifacts/**
# gate-watch: src/tools/crewmate/**
# gate-watch: scripts/lib/observed_walk.py
# gate-watch: src/tools/edit/** src/tools/kit/** src/tools/notebook-edit/**
# gate-watch: src/tools/write/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/cockpit-interaction-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'cockpit-interaction-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members cockpit-interaction-drives 'scripts/cockpit-interaction/$name' "$here/members.txt"
