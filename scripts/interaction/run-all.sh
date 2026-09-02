#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/design-system/ThemeProvider* src/components/mercuryPalette*
# gate-watch: src/components/mercury-ui/InteractiveRow* src/components/mercury-ui/NavigablePanes*
# gate-watch: src/ink/** src/state/AppState* src/utils/inputRange* src/utils/mercuryTokens*
# gate-watch: src/components/MessageSelector* src/keybindings/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/interaction/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ INTERACTION SUITE GREEN"; else echo "❌ INTERACTION SUITE RED"; fi
exit "$fail"
