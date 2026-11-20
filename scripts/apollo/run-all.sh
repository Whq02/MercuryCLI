#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/ApolloReviewTool/**
# gate-watch: src/utils/permissions/PermissionUpdate*
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/utils/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/cli/headless/*
# gate-watch: src/screens/chat/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/apollo"
fail=0
echo "############################################################"
echo "# apollo — station · pack · letters · review handoff · the one door · faces"
echo "############################################################"
drive_members apollo 'scripts/apollo/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "apollo suite: RED"
  exit 1
fi
echo "apollo suite: green"
