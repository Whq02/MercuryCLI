#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/ink/**
# gate-watch: src/keybindings/**
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: scripts/lib/*
# gate-watch: src/* src/components/* src/components/PromptInput/* src/components/mercury-ui/*
# gate-watch: src/hooks/*
# gate-watch: src/utils/*
# gate-watch: docs/SESSIONS.md src/commands/copy/index.ts src/components/HelpV2/ShortcutsTab.tsx src/components/Settings/Config.tsx src/utils/config/schema.ts
# gate-watch: src/screens/chat/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/interaction"
fail=0
drive_members interaction 'scripts/interaction/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ INTERACTION SUITE GREEN"; else echo "❌ INTERACTION SUITE RED"; fi
exit "$fail"
