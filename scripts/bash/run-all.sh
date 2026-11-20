#!/usr/bin/env bash
# gate-class: pure
# gate-env: MERCURY_PROOF_POISON_SCRUB MERCURY_SHELL_ENGINE MERCURY_TMPDIR
# gate-watch: src/tasks/LocalShellTask/*
# gate-watch: src/tools/TaskStopTool/*
# gate-watch: src/utils/hooks/background.ts src/tools/MonitorTool/*
# gate-watch: src/services/projectLocal/paths.ts
# gate-watch: src/utils/shell/shellProvider*
# gate-watch: src/utils/*
# gate-watch: src/utils/hooks/fire.ts
# gate-watch: src/utils/shell/*
# gate-watch: .gitattributes
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/messages/**
# gate-watch: src/services/structure/grammarFacility.ts
# gate-watch: src/utils/shell/** src/utils/bash/** src/utils/powershell/** src/tools/PowerShellTool/** src/tasks/LocalShellTask/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/bash"
fail=0
echo "############################################################"
echo "# Bash permission & security — proof harness"
echo "############################################################"
drive_members bash 'scripts/bash/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BASH PERMISSION PROOFS PASS"; else echo "# ❌ SOME BASH PERMISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
