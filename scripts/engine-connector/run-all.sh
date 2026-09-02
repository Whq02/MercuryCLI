#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/engine-connector/**
# gate-watch: src/services/engine-connector/** src/hooks/useSessionConnector.ts
# gate-watch: src/screens/REPL.tsx src/components/MercuryFrame.tsx src/components/PromptInput/**
# gate-watch: src/components/permissions/** src/hooks/useCancelRequest.ts src/hooks/useDisplayedSessionModel.ts
# The engine-connector suite — the connector contract census, the face
# census (every process-global the face reads routes through the focused
# chat's connector; the engine-side residue is pinned exactly), and the
# in-process implementation's laws. Provers are glob-run so every landed
# prove-*.ts joins the gate automatically (the suite-membership law).
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/engine-connector/prove-*.ts; do
  echo "── engine-connector: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
