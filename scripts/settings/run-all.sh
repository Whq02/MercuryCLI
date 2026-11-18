#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/mistral/**
# gate-watch: src/services/providers/zen/**
# gate-watch: src/services/providers/patience.ts
# gate-watch: src/utils/model/providerFrontier.ts
# gate-watch: src/bootstrap/runtime/posture.ts
# gate-watch: src/utils/settings/**
# gate-watch: src/utils/fileRead*
# gate-watch: src/components/Settings/**
# gate-watch: src/utils/accounts/** src/services/oauth/**
# gate-watch: src/services/engine-connector/**
# gate-watch: scripts/ui/gridToPng.ts
# gate-watch: src/services/providers/openai/openaiCatalogue.ts src/hooks/useCatalogueEpoch.ts src/services/providers/huggingface/huggingfaceCatalogue.ts src/services/providers/local/localAccounts.ts src/components/ConfigurableShortcutHint.tsx
# gate-watch: src/*
# gate-watch: src/services/instructions/* src/services/instructions/adapters/**
# gate-watch: src/utils/permissions/filesystem.ts
# gate-watch: src/utils/*
# gate-watch: src/utils/cockpit/* src/utils/permissions/PermissionUpdate.ts
# gate-watch: src/services/providers/moonshot/** src/services/providers/huggingface/** src/services/providers/gemini/** src/services/providers/openrouter/** src/services/providers/local/** src/services/providers/openaicompat/** src/services/providers/deepseek/** src/services/providers/providerSecrets.ts
# gate-watch: src/services/localServer/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/ui/fixtures/settings-popup-header/*
# gate-watch: src/services/providers/nous/nousAccounts.ts
# gate-watch: src/utils/git.ts
# gate-watch: src/utils/health/sections/crew.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# settings — configuration pipeline proof harness"
echo "############################################################"
shopt -s nullglob
export TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
