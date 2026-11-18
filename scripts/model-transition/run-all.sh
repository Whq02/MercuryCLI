#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/fabric/** src/utils/sessionStorage/** src/services/providers/**
# gate-watch: scripts/ui/*
# gate-watch: src/components/*
# gate-watch: src/components/messages/*
# gate-watch: src/services/* src/services/api/*
# gate-watch: src/services/crew/*
# gate-watch: src/services/instructions/* src/services/run/*
# gate-watch: src/tools/AgentTool/prompt.ts
# gate-watch: src/utils/*
# gate-watch: src/utils/messages/*
# gate-watch: src/utils/model/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/run-core/turn/**
# gate-watch: src/screens/chat/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/model-transition/prove-*.ts; do
  echo "── model-transition: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
