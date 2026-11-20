#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/interaction/**
# gate-watch: src/components/design-system/ThemeProvider* src/components/mercuryPalette*
# gate-watch: src/ink/** src/utils/inputRange* src/utils/mercuryTokens*
# gate-watch: src/components/MessageSelector* src/keybindings/**
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/components/* src/components/PromptInput/* src/components/Settings/*
# gate-watch: src/components/concourse/*
# gate-watch: src/components/extensions/* src/components/mcp/*
# gate-watch: src/components/mercury-ui/*
# gate-watch: src/components/mercury-ui/screens/*
# gate-watch: src/components/tasks/*
# gate-watch: src/hooks/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/interaction-pure"

fail=0
drive_members interaction-pure 'scripts/interaction/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ INTERACTION-PURE SUITE GREEN"; else echo "❌ INTERACTION-PURE SUITE RED"; fi
exit "$fail"
