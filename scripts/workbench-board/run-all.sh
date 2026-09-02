#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/prompts-panel/**
# gate-watch: src/services/workbench/**
# gate-watch: src/services/workContexts/**
# gate-watch: src/utils/worktree.ts
# gate-watch: src/utils/cwd.ts
# gate-watch: src/services/walkthrough/**
# gate-watch: src/utils/artifacts/**
#
# workbench-board — the defect-hunt suite (the board itself retired in place
# — /workbench is the prompts panel;
# its walkthrough verb went with it).
# L-4 handoff provisioning guard anchors on getCwd (the provisioner's own
# anchor — wrong-project lane class); the service law outlives the board.
# (L-1 rides scripts/run-continuity/prove-stream-fault-presentation.ts · L-2 rides
# scripts/memory/prove-promote-rungate-wire.ts · L-5 rides
# scripts/editor-bridge/prove-acp-server.ts — each law lives with its owner suite.)
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

BUN="${BUN:-$HOME/.bun/bin/bun}"
cd "$(dirname "$0")/../.."

fail=0
for f in scripts/workbench-board/prove-*.ts; do
  echo "── $f"
  __t=$SECONDS; "$BUN" run "$f" || fail=1; prover_mark "$f" "$__t"
done
exit $fail
