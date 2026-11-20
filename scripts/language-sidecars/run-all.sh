#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_PROVE_WEB_BUNDLE
# gate-watch: src/services/structure/** src/tools/StructureTool/**
# gate-watch: src/services/lsp/webSidecar/**
# gate-watch: src/services/browser/** src/tools/BrowserTool/** src/commands/browser/**
# gate-watch: src/utils/healthReport.ts
# gate-watch: vendor/grammar-licences/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/language-sidecars"
fail=0
echo "############################################################"
echo "# language-sidecars — native IDE payload suite"
echo "############################################################"
drive_members language-sidecars 'scripts/language-sidecars/$name' "$here/members.txt" || fail=1
exit "$fail"
