#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/** src/utils/toolSearch* src/utils/api.ts
# gate-watch: src/tools/ToolSearchTool/** src/utils/attachments/deltas* src/utils/model/capabilities*
# ============================================================================
#  scripts/tool-economy/run-all.sh — the tool-surface economy suite: the
#  per-route prefix instrument and the route-independent deferral laws
#  (every provider route defers; admission is monotone; the wire form is a
#  per-route capability, never a per-call guess). Globs prove-*.ts and the
#  measure-*.ts instrument; auto-joins the pool via scripts/run-all-suites.sh.
# ============================================================================
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# tool-economy — prefix instrument · route-independent deferral laws"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/measure-*.ts "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit "$fail"
