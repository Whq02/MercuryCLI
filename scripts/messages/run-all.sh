#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/screens/REPL* src/types/message* src/utils/messages/**
# scripts/messages/run-all.sh — message-pipeline proof suite. Auto-joins the pooled green gate via the
# scripts/*/run-all.sh glob.
#
# prove-messages-parity.ts is the golden-replay oracle for the
# src/utils/messages.ts rewrite: a fixed synthetic corpus through every
# covered export, diffed against committed goldens recorded from the
# pre-rewrite module. Regenerate goldens ONLY for a deliberate,
# reviewed behavior change: `bun run … --record`.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── message-pipeline proofs ──"
# Glob so new prove-*.ts auto-join.
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ MESSAGES SUITE GREEN"; exit 0; else
  echo "❌ MESSAGES SUITE RED"; exit 1; fi
