#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/dap/dapClient* src/services/lsp/** src/services/run/effectObserver*
# gate-watch: src/services/run/ownerKey* src/services/tcpBridge/entry* src/substrate/flagRegistry*
# gate-watch: src/tools/LSPTool/** src/utils/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
exit $fail
