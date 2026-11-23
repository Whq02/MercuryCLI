#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/crew/crewmates/* src/screen/composer/**
# gate-watch: assets/splash/** src/screen/renderer/**
# gate-watch: scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/screen/tasks/*
# gate-watch: scripts/ui/renderScenarios.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/render-continuity"
failed=0
drive_members render-continuity 'scripts/render-continuity/$name' "$here/members.txt" || failed=1

exit "$failed"
