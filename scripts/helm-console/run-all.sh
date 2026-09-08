#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/ui/render-tui.ts scripts/ui/vshot.py src/components/mercury-ui/glyphs*
# gate-watch: src/constants/spinnerVerbs* src/utils/cockpit/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Helm console — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-console-store.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-console-store.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-console-text.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-console-text.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-console-wiring.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-console-wiring.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-console-ask.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-console-ask.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-hip-vocab.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hip-vocab.ts" "$__t" "$__rc"
if [ "$fail" -ne 0 ]; then
  echo "❌ helm-console suite: FAILURES"
  exit 1
fi
echo "✅ helm-console suite: ALL GREEN"
