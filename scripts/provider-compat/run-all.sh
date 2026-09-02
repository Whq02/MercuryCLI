#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/routeLaw* src/services/providers/openaicompat/**
# gate-watch: src/services/providers/moonshot/** src/services/providers/deepseek/**
# gate-watch: src/services/providers/huggingface/** src/services/providers/local/**
# gate-watch: src/services/providers/zai/glmPins* src/utils/router/providers/**
# gate-watch: src/utils/model/modelOptions* src/utils/model/capabilities*
# ============================================================================
#  scripts/provider-compat/run-all.sh — the provider proof suite:
#  the extended pure routing law + permission-mode provider neutrality, the
#  shared OpenAI-compatible chat-completions transport (fixture-injected
#  fetch — no network, no key, no billables), the per-lane wire knobs, the
#  key-lane slots/usage/picker derivations, the DeepSeek balance decode, and
#  the Moonshot RFC-8628 device-flow client. Globs prove-*.ts; the suite
#  auto-joins the green gate via scripts/run-all-suites.sh's glob.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
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
