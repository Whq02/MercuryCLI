#!/usr/bin/env bash
# gate-class: cpu

# gate-watch: src/services/structure/** src/tools/StructureTool/**
# gate-watch: src/services/repoHost/** src/services/gitGraph/** src/tools/GitTool/**
# gate-watch: src/services/ide/pythonTests.ts src/tools/TestTool/**
# gate-watch: src/services/resources/adapters/repo.ts src/services/resources/adapters/structure.ts
# gate-watch: src/tools/AstSearchTool/** src/tools/AstEditTool/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/structure-tools"
fail=0
echo "############################################################"
echo "# MERCURY structure-tools — developer-tooling bridge suite"
echo "############################################################"
drive_members structure-tools 'scripts/structure-tools/$name' "$here/members.txt" || fail=1
exit "$fail"
