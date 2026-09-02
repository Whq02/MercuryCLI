#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/search/** src/tools/WebSearchTool/**
# gate-watch: src/services/providers/openai/openaiWire* src/services/providers/openai/responsesBridge*
# gate-watch: src/tools/WebFetchTool/utils* src/utils/http*
# ============================================================================
#  scripts/search/run-all.sh — the web-search estate's proof suite: the
#  parsers over captured page/body fixtures (with their shape poisons), the
#  pure selection law, and the live tool driven through every door against
#  loopback fixture servers (never live network — the base-URL proof seams
#  pin every endpoint to 127.0.0.1).
#  Globs prove-*.ts; auto-joins the pool via scripts/run-all-suites.sh.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# Glob every prove-*.ts so new proofs auto-join and none can be orphaned/ungated.
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
exit $fail
