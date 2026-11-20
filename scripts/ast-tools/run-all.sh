#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/tools/AstSearchTool/**
# gate-watch: src/main.tsx
# gate-watch: src/tools/BashTool/utils.ts src/utils/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ast-tools"
fail=0
echo "############################################################"
echo "# ast-tools — structural search and edit"
echo "############################################################"
drive_members ast-tools 'scripts/ast-tools/$name' "$here/members.txt" || fail=1
exit "$fail"
