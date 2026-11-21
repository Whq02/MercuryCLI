#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/cli/headless/**
# gate-watch: src/cli/run* src/components/App* src/constants/oauth*
# gate-watch: src/ink/**
# gate-watch: src/query/**
# gate-watch: src/services/providers/anthropic/**
# gate-watch: src/types/ids* src/utils/**
# gate-watch: src/commands/caching/**
# gate-watch: src/run-core/turn/**
# gate-watch: src/rows/*
# gate-watch: src/screens/chat/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/core-runtime"
fail=0
drive_members core-runtime 'scripts/core-runtime/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" = "0" ]; then echo "core-runtime suite: green"; else echo "core-runtime suite: RED"; fi
exit "$fail"
