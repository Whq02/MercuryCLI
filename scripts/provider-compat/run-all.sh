#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/routeLaw* src/services/providers/openaicompat/**
# gate-watch: src/services/providers/moonshot/** src/services/providers/deepseek/**
# gate-watch: src/services/providers/huggingface/** src/services/providers/local/**
# gate-watch: src/services/providers/zai/glmPins* src/utils/router/providers/**
# gate-watch: src/utils/model/modelOptions* src/utils/model/capabilities*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# provider-compat — multi-provider proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit "$fail"
