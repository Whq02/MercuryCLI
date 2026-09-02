#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/interview/**
# gate-watch: src/tools/AskUserQuestionTool/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/utils/planModeV2.ts src/utils/messages/attachmentText.ts src/tools/EnterPlanModeTool/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# INTERVIEW — the evidence-first design-conversation lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$repro") || fail=1; prover_mark "$repro" "$__t"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ INTERVIEW PASS"; else echo "# ❌ INTERVIEW FAILED"; fi
echo "############################################################"
exit "$fail"
