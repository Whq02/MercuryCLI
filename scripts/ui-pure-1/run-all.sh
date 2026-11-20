#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/**
# gate-watch: src/services/host/** src/commands/llmhost/** src/tools/BashTool/** src/commands/restart/**
# gate-watch: src/commands/mcp/**
# gate-watch: src/commands/appearance/index*
# gate-watch: src/commands/run/runInspectorModel*
# gate-watch: src/commands/crew/index* src/context/overlayContext*
# gate-watch: src/daemon/** src/ink/**
# gate-watch: src/services/anthropicLimits*
# gate-watch: src/services/run/**
# gate-watch: src/substrate/bootNotes*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: scripts/lib/*
# gate-watch: src/context/* src/hooks/* src/input-core/*
# gate-watch: src/keybindings/*
# gate-watch: src/services/api/*
# gate-watch: src/services/engine-connector/*
# gate-watch: src/services/mcp/*
# gate-watch: src/services/switchboard/*
# gate-watch: src/substrate/*
# gate-watch: src/cli/headless/turnDriver.ts src/types/textInputTypes.ts
# gate-watch: src/screens/chat/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-pure-1"

fail=0
drive_members ui-pure-1 'scripts/ui/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ UI-PURE-1 SUITE GREEN"; else echo "❌ UI-PURE-1 SUITE RED"; fi
exit "$fail"
