#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/routeLaw* src/services/providers/openaicompat/**
# gate-watch: src/services/providers/moonshot/** src/services/providers/deepseek/**
# gate-watch: src/services/providers/huggingface/** src/services/providers/local/**
# gate-watch: src/services/providers/zai/glmPins* src/utils/router/providers/**
# gate-watch: src/utils/model/modelOptions* src/utils/model/capabilities*
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
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit "$fail"
