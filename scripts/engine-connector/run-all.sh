#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/engine-connector/**
# gate-watch: src/services/engine-connector/** src/hooks/useSessionConnector.ts
# gate-watch: src/screens/REPL.tsx src/components/MercuryFrame.tsx src/components/PromptInput/**
# gate-watch: src/components/permissions/** src/hooks/useCancelRequest.ts src/hooks/useDisplayedSessionModel.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
claimed=$(cat scripts/engine-connector-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for f in scripts/engine-connector/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  echo "── engine-connector: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
