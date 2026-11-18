#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/attachments/**
# gate-watch: src/services/projectIntel/capsule.ts
# gate-watch: src/hooks/usePasteHandler*
# gate-watch: src/constants/prompts.ts src/constants/systemPromptSections.ts
# gate-watch: src/utils/sessionStorage/chain.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── context-assembly proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-attachments-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-attachments-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-mention-grammar.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-mention-grammar.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-mention-resolution.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-mention-resolution.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-image-mention-dropped.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-image-mention-dropped.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-dropped-notice-wraps.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-dropped-notice-wraps.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-producer-gates.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-producer-gates.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-phase-delivery.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-phase-delivery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-ledgers.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-ledgers.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-nested-memory-admission.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-nested-memory-admission.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-pasted-image-blocks.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-pasted-image-blocks.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-async-hook-delivery.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-async-hook-delivery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-read-cache-bounds.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-read-cache-bounds.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-file-change-observation.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-file-change-observation.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-file-admission.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-file-admission.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-dense-mention-carried-clipped.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-dense-mention-carried-clipped.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-mentioned-file-waits-for-its-read.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-mentioned-file-waits-for-its-read.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-receipts.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-receipts.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-facts.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-facts.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-request.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-request.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-capsule-turn.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-capsule-turn.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-image-road.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-image-road.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-tool-result-image-note.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-tool-result-image-note.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-stored-image-assembly.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-stored-image-assembly.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-session-context-once.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-session-context-once.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-turn-attachment-roster.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-turn-attachment-roster.ts" "$__t" "$__rc"
if [[ "$fail" == "0" ]]; then echo "✅ ATTACHMENTS SUITE GREEN"; exit 0; else
  echo "❌ ATTACHMENTS SUITE RED"; exit 1; fi
