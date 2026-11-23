#!/usr/bin/env bash
# gate-class: pure
# gate-env: MERCURY_PROOF_POISON_GUARD MERCURY_PYTHON
# gate-watch: scripts/*/run-all.sh scripts/*/members.txt
# gate-watch: scripts/lib/**
# gate-watch: src/daemon/runner-wire/* src/daemon/runner/*
# gate-watch: bunfig.toml
# gate-watch: scripts/verify/fast.ts scripts/verify/impact.ts scripts/verify/sliceCore.ts
# gate-watch: scripts/verify/prove-impact-manifest.ts scripts/verify/prove-impact-run.ts scripts/verify/prove-slice-core.ts
# gate-watch: src/engine/rows/* src/engine/tasks/local-shell/killShellTasks.ts src/engine/tasks/local-shell/shellTask.tsx
# gate-watch: src/tools/shell/BashTool.tsx src/tools/shell/BashToolResultMessage.tsx src/tools/shell/rows.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
. "$(dirname "$0")/../lib/proof-runner.sh"
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$0")/../.." || exit 1
fail=0
echo "############################################################"
echo "# Gate machinery"
echo "############################################################"
drive_members gate 'scripts/gate/$name' "$here/members.txt" || fail=1
run_proof "$here/prove-source-text-reads.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-source-text-reads.ts" || fail=1
run_proof "$here/prove-source-patterns.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-source-patterns.ts" || fail=1
run_proof "$here/prove-unit-size.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-unit-size.ts" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ GATE MACHINERY PASS"; else echo "# ❌ GATE MACHINERY FAILED"; fi
echo "############################################################"
exit "$fail"
