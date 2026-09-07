#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/search/** src/tools/WebSearchTool/**
# gate-watch: src/services/providers/openai/openaiWire* src/services/providers/openai/responsesBridge*
# gate-watch: src/tools/WebFetchTool/utils* src/utils/http*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
exit $fail
