#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/engine-connector/**
# gate-watch: scripts/lib/*
# gate-watch: src/components/*
# gate-watch: src/components/mercury-ui/screens/*
# gate-watch: src/components/tasks/* src/daemon/*
# gate-watch: src/services/*
# gate-watch: src/tools/AgentTool/*
# gate-watch: src/utils/*
# gate-watch: src/rows/*
# gate-watch: src/utils/health/sections/*
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
claimed=$(members_cat scripts/engine-connector-*/members.txt)

for f in scripts/engine-connector/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  echo "── engine-connector: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
