#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/run-core/turn/**
# gate-watch: src/tools/CheckpointTool/** src/tools/RewindTool/**
# gate-watch: scripts/lib/*
# gate-watch: src/*
# gate-watch: src/components/*
# gate-watch: src/constants/betas.ts
# gate-watch: src/services/api/*
# gate-watch: src/services/providers/*
# gate-watch: src/services/providers/anthropic/*
# gate-watch: src/services/providers/openai/*
# gate-watch: src/utils/*
# gate-watch: src/utils/attachments/*
# gate-watch: src/utils/messages/*
# gate-watch: src/services/instructions/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/types/message.ts
# gate-watch: src/mneme/*
# gate-watch: src/services/tools/toolOrchestration.ts src/tools/FileReadTool/limits.ts
# gate-watch: src/commands/context/context-noninteractive.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# compact — context maintenance proofs"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit "$fail"
