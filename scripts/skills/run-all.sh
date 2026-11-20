#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/** mercury-skills/**
# gate-watch: src/skills/*
# gate-watch: src/tools/SkillTool/* src/utils/*
# gate-watch: src/rows/turn.ts src/utils/config/trust.ts
# gate-watch: README.md src/utils/settings/**
# gate-watch: src/extensions/load/commands.ts src/extensions/bundled/**
# gate-watch: src/services/crewBoard/** src/tools/AgentTool/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/skills"
fail=0
drive_members skills 'scripts/skills/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ SKILLS SUITE GREEN"; else echo "❌ SKILLS SUITE RED"; fi
exit "$fail"
