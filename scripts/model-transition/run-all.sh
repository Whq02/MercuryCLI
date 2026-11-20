#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/fabric/** src/utils/sessionStorage/** src/services/providers/**
# gate-watch: scripts/ui/*
# gate-watch: src/components/*
# gate-watch: src/components/messages/*
# gate-watch: src/services/* src/services/api/*
# gate-watch: src/services/crew/*
# gate-watch: src/services/instructions/* src/services/run/*
# gate-watch: src/tools/AgentTool/prompt.ts
# gate-watch: src/utils/*
# gate-watch: src/utils/messages/*
# gate-watch: src/utils/model/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/run-core/turn/**
# gate-watch: src/screens/chat/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/model-transition"
failed=0
drive_members model-transition 'scripts/model-transition/$name' "$here/members.txt" || failed=1

exit "$failed"
