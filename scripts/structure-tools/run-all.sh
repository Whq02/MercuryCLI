#!/usr/bin/env bash
# gate-class: cpu

# gate-watch: src/tools/engines/structure/** src/tools/structure/**
# gate-watch: src/platform/repo-host/** src/platform/git-graph/** src/tools/git/**
# gate-watch: src/integrations/ide/pythonTests.ts src/tools/test/**
# gate-watch: src/integrations/resources/adapters/repo.ts src/integrations/resources/adapters/structure.ts
# gate-watch: src/tools/ast-search/** src/tools/ast-edit/**
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
