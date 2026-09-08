#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: scripts/visual-contract/**
# gate-watch: assets/splash/** src/components/mercury-ui/** src/components/mercuryPalette.ts
# gate-watch: src/utils/mercuryTokens.ts src/utils/helmGeometry.ts src/utils/hyperlink.ts
# gate-watch: src/utils/earlyInput.ts src/hooks/usePasteHandler.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# visual-contract — the frontier presentation & interaction lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$repro") || { __rc=$?; fail=1; }; prover_mark "$repro" "$__t" "$__rc"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ visual-contract PASS"; else echo "# ❌ visual-contract FAILED"; fi
echo "############################################################"
exit "$fail"
