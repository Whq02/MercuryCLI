#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/QueryEngine* src/commands/all/index*
# gate-watch: src/components/PromptInput/PromptInput* src/components/mercuryPalette*
# gate-watch: src/components/messages/UserTeammateMessage*
# gate-watch: src/components/mercury-ui/scribeChatTabs* src/components/mercury-ui/sessionAccent*
# gate-watch: src/constants/spinnerVerbs* src/daemon/** src/memdir/** src/services/lsp/mercuryLsp*
# gate-watch: src/services/run/continuationLatch* src/state/AppState* src/tools/BriefTool/prompt*
# gate-watch: src/tools/RememberLessonTool/RememberLessonTool* src/types/message* src/utils/**
# Scribe Mode "Amanuensis" — proof harness. Runs every scripts/scribe/prove-*.ts
# via bun run; non-zero exit on any failure. New proofs are picked up by the glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Scribe Mode (Amanuensis) — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SCRIBE PROOFS PASS"; else echo "# ❌ SOME SCRIBE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
