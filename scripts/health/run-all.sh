#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/cli/healthJson* src/services/dap/dapClient* src/services/run/ownerLifecycle*
# gate-watch: src/substrate/startupMenu* src/utils/**
# gate-watch: assets/splash/launcher-action-block.sh scripts/cockpit-interaction/status-popup-fixture.ts
# gate-watch: scripts/lib/firstRunSeed.ts scripts/ops/launcher-mercury.sh scripts/splash/deploy.sh
# gate-watch: scripts/ui/fixtures/sandbox-paths/platform.cjs scripts/ui/renderScenarios.ts
# gate-watch: src/bootstrap/state.ts src/cli/handlers/util.tsx src/cli/healthPresentation.ts src/cli/update.ts
# gate-watch: src/commands/health/HealthCertificate.tsx src/commands/health/health.tsx src/daemon/*
# gate-watch: src/history.ts src/keybindings/loadUserBindings.ts src/main.tsx src/services/counsel/counsel.ts
# gate-watch: src/services/instructions/contracts.ts src/services/instructions/engine.ts
# gate-watch: src/services/privateChannel/installProvenance.ts
# gate-watch: src/services/providers/anthropic/anthropicCatalogue.ts
# gate-watch: src/services/providers/anthropic/modelRefusal.ts
# gate-watch: src/services/providers/credentialEnvSpellings.ts
# gate-watch: src/services/providers/deepseek/deepseekCatalogue.ts
# gate-watch: src/services/providers/deepseek/deepseekPins.ts src/services/providers/gemini/geminiCatalogue.ts
# gate-watch: src/services/providers/gemini/geminiPins.ts
# gate-watch: src/services/providers/huggingface/huggingfaceCatalogue.ts
# gate-watch: src/services/providers/huggingface/huggingfacePins.ts
# gate-watch: src/services/providers/moonshot/kimiPins.ts src/services/providers/moonshot/moonshotCatalogue.ts
# gate-watch: src/services/providers/openai/gptPins.ts src/services/providers/openai/openaiCatalogue.ts
# gate-watch: src/services/providers/typedModelIds.ts src/substrate/flagRegistry.ts
# gate-watch: src/substrate/launchMilestones.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
echo "############################################################"
echo "# /health certificate — proof harness"
echo "############################################################"
shopt -s nullglob
claimed=$(cat scripts/health-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL HEALTH PROOFS PASS"; else echo "# ❌ SOME HEALTH PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
