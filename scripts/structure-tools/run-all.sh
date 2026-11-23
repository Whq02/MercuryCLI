#!/usr/bin/env bash
# gate-class: cpu

# gate-watch: src/integrations/ide/pythonTests.ts src/integrations/resources/adapters/repo.ts
# gate-watch: src/integrations/resources/adapters/structure.ts src/platform/git-graph/** src/platform/repo-host/**
# gate-watch: src/tools/ast-edit/** src/tools/ast-search/**
# gate-watch: src/tools/engines/structure/** src/tools/git/**
# gate-watch: src/tools/structure/** src/tools/test/**
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
