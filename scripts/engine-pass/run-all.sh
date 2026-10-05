#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/ink/** src/ink.ts
# gate-watch: src/utils/staticRender.tsx src/components/mercury-ui/** assets/splash/**
# gate-watch: scripts/ui/** scripts/critters/fixtures/** scripts/critters/zzzFrames.ts scripts/engine-connector/fixtures/**
# gate-watch: design-system/live/** scripts/lib/ptyRecorder.ts scripts/lib/firstRunSeed.ts
# gate-watch: scripts/engine-connector/prove-crew-token-rows.ts scripts/critters/prove-critter-sleep.ts scripts/visual-contract/baseline-capture.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-bun}"
fail=0
run_proof scripts/engine-pass/prove-judge-teeth.ts "$BUN" scripts/engine-pass/prove-judge-teeth.ts || fail=1
run_proof scripts/engine-pass/prove-recorder.ts "$BUN" scripts/engine-pass/prove-recorder.ts || fail=1
run_proof scripts/engine-pass/prove-engine-contract.ts "$BUN" scripts/engine-pass/prove-engine-contract.ts || fail=1
run_proof scripts/engine-pass/prove-frames-identical.ts "$BUN" scripts/engine-pass/prove-frames-identical.ts || fail=1
run_proof scripts/engine-pass/prove-frame-cost.ts "$BUN" scripts/engine-pass/prove-frame-cost.ts || fail=1
exit "$fail"
