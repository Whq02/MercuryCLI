#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/temporaryStreamError.ts src/services/providers/openai/**
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/services/providers/openrouter/** src/utils/settings/**
# gate-watch: src/services/providers/huggingface/** src/services/providers/local/**
# gate-watch: src/services/providers/zai/glmPins* src/services/providers/**
# gate-watch: src/types/message.ts src/components/CompatConnect.tsx
# gate-watch: src/services/providers/gemini/** src/services/providers/xai/** src/services/providers/meta/**
# gate-watch: src/services/providers/mistral/**
# gate-watch: src/services/providers/zen/** src/services/providers/zen/zenAdapter.ts
# gate-watch: src/services/providers/groq/** src/services/providers/cerebras/** src/services/providers/fireworks/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/providers/nous/**
# gate-watch: src/services/providers/minimax/** src/services/providers/together/** src/services/providers/cohere/**
# gate-watch: src/services/providers/melious/**
# gate-watch: src/services/api/outputFit.ts
# gate-watch: src/services/providers/cacheFieldRetry.ts
# gate-watch: src/services/engine-connector/seatLive.ts
# gate-watch: src/utils/healthReport.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# provider-compat — multi-provider proof harness"
echo "############################################################"
shopt -s nullglob
echo "# Engine request contracts: prove-engine-shapes.ts and prove-tool-schemas-no-refs.ts"
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit "$fail"
