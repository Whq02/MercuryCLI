#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/tools/FileReadTool/** src/tools/FileEditTool/** src/tools/FileWriteTool/**
# gate-watch: src/services/changeTransaction/** src/services/ide/** src/services/resources/**
# gate-watch: src/tools/TransactionTool/** src/utils/verification/**
# gate-watch: src/services/repoHost/** src/tools/GitTool/** src/tools/TestTool/** src/tools/LaunchTool/**
# gate-watch: src/services/run/*
# gate-watch: src/utils/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/mneme/ledger.ts src/mneme/paths.ts
# gate-watch: scripts/tools/fixtures/read-formats/**
# gate-watch: src/services/health/sections/coding-loop-fast.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/edit-tools"
fail=0
echo "############################################################"
echo "# edit-tools — utility workbench suite"
echo "############################################################"
drive_members edit-tools 'scripts/edit-tools/$name' "$here/members.txt" || fail=1
exit "$fail"
