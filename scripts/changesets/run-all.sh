#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/changesets/**
# gate-watch: src/services/changeTransaction/** src/tools/ChangeSetTool/**
# gate-watch: src/components/permissions/ChangeSetPermissionRequest/** src/components/InlineChangeView.tsx
# gate-watch: src/substrate/operationJournal.ts src/substrate/durableOperationMatrix.ts src/substrate/recoveryOrchestrator.ts
# gate-watch: src/tools/LSPTool/mercuryOps.ts src/services/structure/transform.ts src/services/structure/polyglotTransform.ts
# ============================================================================
#  scripts/changesets/run-all.sh — atomic multi-file text
#  change sets. Members (globbed — new proofs auto-join):
#
#    prove-changeset-planning.ts   the nine-step preflight: bounds ·
#                                  duplicates · anchors · hunks · digest
#                                  determinism · owner isolation · expiry ·
#                                  discard · store honesty
#    prove-changeset-zero-write.ts the zero-write laws: one invalid/denied/
#                                  drifted member ⇒ NO member written;
#                                  cancellation; all-no-change; preview
#    prove-changeset-apply.ts      exact landing · noChange exclusion · ONE
#                                  effect/receipt/transaction · read-state/
#                                  notify coverage · replay · concurrency
#    prove-changeset-recovery.ts   fault injection at EVERY interruption
#                                  boundary (FC9): roll-forward ·
#                                  compensation · second-restart idempotence ·
#                                  exact indeterminate paths · later bytes
#                                  never overwritten
#    prove-changeset-migration.ts  Structure+LSP ride the shared core; the
#                                  duplicated write/rollback/reread mechanics
#                                  are DELETED; contracts held or improved
#    prove-changeset-card.ts       the aggregate inline change view at 80 +
#                                  120 cols across every state
#    prove-changeset-flag.ts       MERCURY_CHANGESET registry row + =0
#                                  catalog byte-equivalence
#
#  Deterministic throughout: no wall-clock sleeps — fault seams
#  (MERCURY_FAULT_INJECT) + write counters + hermetic MERCURY_CHANGESET_DIR.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MERCURY changesets — atomic multi-file text change sets"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo ""
  echo "== $name =="
  __t=$SECONDS; if ! "$bun" "$f"; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t"
done
exit "$fail"
