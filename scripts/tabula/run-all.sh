#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ui/vshot.py src/bootstrap/state* src/commands/tabula/** src/utils/tabula/**
# gate-watch: src/utils/cockpit/helmFocus* src/utils/cockpit/minervaRepl*
# TABULA proofs — the realm-scoped note ledger + MINERVA boot curator
# (MERCURY_TABULA / MERCURY_TABULA_MINERVA / MERCURY_TABULA_DIR).
# Auto-joins scripts/run-all-suites.sh via the glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# TABULA — note ledger + MINERVA curator"
echo "############################################################"
__t=$SECONDS; "$BUN" run "$here/prove-tabula-store.ts" || fail=1; prover_mark "$here/prove-tabula-store.ts" "$__t"
if [ -f "$here/prove-tabula-surfaces.ts" ]; then
  __t=$SECONDS; "$BUN" run "$here/prove-tabula-surfaces.ts" || fail=1; prover_mark "$here/prove-tabula-surfaces.ts" "$__t"
fi
if [ -f "$here/prove-minerva.ts" ]; then
  __t=$SECONDS; "$BUN" run "$here/prove-minerva.ts" || fail=1; prover_mark "$here/prove-minerva.ts" "$__t"
fi
if [ -f "$here/prove-minerva-repl.ts" ]; then
  __t=$SECONDS; "$BUN" run "$here/prove-minerva-repl.ts" || fail=1; prover_mark "$here/prove-minerva-repl.ts" "$__t"
fi
if [ -f "$here/prove-minerva-decode.ts" ]; then
  __t=$SECONDS; "$BUN" run "$here/prove-minerva-decode.ts" || fail=1; prover_mark "$here/prove-minerva-decode.ts" "$__t"
fi
if [ -f "$here/prove-minerva-flow.ts" ]; then
  __t=$SECONDS; "$BUN" run "$here/prove-minerva-flow.ts" || fail=1; prover_mark "$here/prove-minerva-flow.ts" "$__t"
fi
if [ -f "$here/prove-structured-output-dialect.ts" ]; then
  __t=$SECONDS; "$BUN" run "$here/prove-structured-output-dialect.ts" || fail=1; prover_mark "$here/prove-structured-output-dialect.ts" "$__t"
fi
if [ -f "$here/prove-minerva-refine-defaults.ts" ]; then
  __t=$SECONDS; "$BUN" run "$here/prove-minerva-refine-defaults.ts" || fail=1; prover_mark "$here/prove-minerva-refine-defaults.ts" "$__t"
fi
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ TABULA PASS"; else echo "# ❌ TABULA FAILED"; fi
echo "############################################################"
exit "$fail"
