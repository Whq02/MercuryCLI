#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/**
# gate-watch: src/query/stopHooks*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/healthReport.ts src/utils/hooks/fire.ts src/guards/**
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

PROOFS=(
  prove-persistence-corpus.ts
  prove-bm-classes.ts
  prove-progress-model.ts
  prove-prefix-fingerprint.ts
  prove-tool-delta-grammar.ts
  prove-run-phases.ts
  prove-run-stop-hook.ts
  prove-turn-rules.ts
)

echo "############################################################"
echo "# stop-policy — evidence-gated persistence proof harness"
echo "############################################################"
for proof in "${PROOFS[@]}"; do
  echo
  echo "── $proof ──"
  __t=$SECONDS; __rc=0; "$bun" run "$here/$proof" || { __rc=$?; fail=1; }; prover_mark "$here/$proof" "$__t" "$__rc"
done
exit $fail
