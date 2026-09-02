#!/usr/bin/env bash
# gate-class: cpu
# (this suite boots the real dist as a HEADLESS child (no PTY); the class annotation lives on this line: the gate registry parses the header line as the bare class)
# gate-watch: src/utils/projectConfig* src/substrate/flagRegistry*
# ============================================================================
#  tree-ownership — the §13 proof suite: whole-tree ownership partition,
#  namespace laws (fresh-native · canonical-wins · legacy-access ratchet),
#  suite membership (no orphan provers), and the Mercury-only packaged boot.
#  non-regression rides the pool directly (dev-context is a standing suite).
#  Runs every prove-*.ts via the glob.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
command -v "$bun" >/dev/null 2>&1 || bun=bun
fail=0
echo "############################################################"
echo "# tree-ownership — §13 native-ownership proofs"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL tree-ownership PROOFS PASS"; else echo "# ❌ SOME tree-ownership PROOFS FAILED"; fi
exit "$fail"
