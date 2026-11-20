#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/constants/** src/daemon/**
# gate-watch: src/services/mcp/**
# gate-watch: src/substrate/**
# gate-watch: src/utils/**
# gate-watch: src/* src/*.ts
# gate-watch: src/components/*
# gate-watch: src/services/compact/*
# gate-watch: src/tools/SendMessageTool/SendMessageTool.ts
# gate-watch: src/chatLauncher.tsx
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/substrate"
fail=0
echo "############################################################"
echo "# Mercury substrate — wire-live proof harness"
echo "############################################################"
drive_members substrate 'scripts/substrate/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SUBSTRATE PROOFS PASS"; else echo "# ❌ SOME SUBSTRATE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
