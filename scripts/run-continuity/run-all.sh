#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/commands/run/run.tsx
# gate-watch: src/components/mercury-ui/PaletteView.tsx
# gate-watch: src/components/MercuryQuickOpen.tsx
# gate-watch: src/components/MercurySearch.tsx
# gate-watch: src/components/prompts-panel/**
# gate-watch: src/services/workbench/**
# gate-watch: src/components/diff/**
# gate-watch: src/components/messages/AssistantTextMessage.tsx
# gate-watch: src/utils/messages/lookups.ts
# gate-watch: src/services/api/errors.ts
#
# the tactile-quality pass suite.
# R1 recovered stream-fault presentation · R2 lane identity · R3 workbench
# state grammar · R4 /diff continuity · R5 empty-state hint honesty.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

BUN="${BUN:-$HOME/.bun/bin/bun}"
cd "$(dirname "$0")/../.."

fail=0
for f in scripts/run-continuity/prove-*.ts; do
  echo "── $f"
  __t=$SECONDS; "$BUN" run "$f" || fail=1; prover_mark "$f" "$__t"
done
exit $fail
