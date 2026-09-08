#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ui/vshot.py src/bootstrap/state* src/commands/tabula/** src/utils/tabula/**
# gate-watch: src/utils/cockpit/helmFocus* src/utils/cockpit/minervaRepl*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# TABULA — note ledger + MINERVA curator"
echo "############################################################"
__t=$SECONDS; __rc=0; "$BUN" run "$here/prove-tabula-store.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-tabula-store.ts" "$__t" "$__rc"
if [ -f "$here/prove-tabula-surfaces.ts" ]; then
  __t=$SECONDS; __rc=0; "$BUN" run "$here/prove-tabula-surfaces.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-tabula-surfaces.ts" "$__t" "$__rc"
fi
if [ -f "$here/prove-minerva.ts" ]; then
  __t=$SECONDS; __rc=0; "$BUN" run "$here/prove-minerva.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-minerva.ts" "$__t" "$__rc"
fi
if [ -f "$here/prove-minerva-repl.ts" ]; then
  __t=$SECONDS; __rc=0; "$BUN" run "$here/prove-minerva-repl.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-minerva-repl.ts" "$__t" "$__rc"
fi
if [ -f "$here/prove-minerva-decode.ts" ]; then
  __t=$SECONDS; __rc=0; "$BUN" run "$here/prove-minerva-decode.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-minerva-decode.ts" "$__t" "$__rc"
fi
if [ -f "$here/prove-minerva-flow.ts" ]; then
  __t=$SECONDS; __rc=0; "$BUN" run "$here/prove-minerva-flow.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-minerva-flow.ts" "$__t" "$__rc"
fi
if [ -f "$here/prove-structured-output-dialect.ts" ]; then
  __t=$SECONDS; __rc=0; "$BUN" run "$here/prove-structured-output-dialect.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-structured-output-dialect.ts" "$__t" "$__rc"
fi
if [ -f "$here/prove-minerva-refine-defaults.ts" ]; then
  __t=$SECONDS; __rc=0; "$BUN" run "$here/prove-minerva-refine-defaults.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-minerva-refine-defaults.ts" "$__t" "$__rc"
fi
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ TABULA PASS"; else echo "# ❌ TABULA FAILED"; fi
echo "############################################################"
exit "$fail"
