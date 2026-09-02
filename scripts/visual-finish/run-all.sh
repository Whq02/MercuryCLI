#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/visual-finish/**
# gate-watch: assets/splash/** src/components/mercury-ui/** src/components/mercuryPalette.ts
# gate-watch: src/utils/mercuryTokens.ts src/ink/colorize.ts src/ink/frame-writer.ts
# gate-watch: src/components/MercuryHome.tsx
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# visual-finish — the visual-finish lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

echo
echo "── prove-link-journey.py ──"
__t=$SECONDS; (cd "$repo" && /usr/bin/python3 "$here/prove-link-journey.py") || fail=1; prover_mark "$here/prove-link-journey.py" "$__t"

echo
echo "── prove-resize-return.py ──"
__t=$SECONDS; (cd "$repo" && /usr/bin/python3 "$here/prove-resize-return.py") || fail=1; prover_mark "$here/prove-resize-return.py" "$__t"

for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$repro") || fail=1; prover_mark "$repro" "$__t"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ visual-finish PASS"; else echo "# ❌ visual-finish FAILED"; fi
echo "############################################################"
exit "$fail"
