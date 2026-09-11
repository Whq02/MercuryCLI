#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_SCROLL_REFLOW_STRICT
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/hooks/useVirtualScroll* src/ink/components/ScrollBox*
# gate-watch: src/components/ScrollKeybindingHandler* src/components/VirtualMessageList*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/scroll/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ SCROLL SUITE GREEN"; else echo "❌ SCROLL SUITE RED"; fi
exit "$fail"
