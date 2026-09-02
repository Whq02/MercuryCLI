#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/sessionStorage/** src/utils/sessionStoragePortable.ts src/history.ts
# scripts/sessionStorage/run-all.sh — session-persistence proof suite. Auto-joins the pooled green gate via the glob.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── session-persistence proofs ──"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sessionstorage-parity.ts" || fail=1; prover_mark "$here/prove-sessionstorage-parity.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-key-canonical.ts" || fail=1; prover_mark "$here/prove-project-key-canonical.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-home-fold.ts" || fail=1; prover_mark "$here/prove-project-home-fold.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-key-stability.ts" || fail=1; prover_mark "$here/prove-project-key-stability.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-recognition.ts" || fail=1; prover_mark "$here/prove-project-recognition.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-history-flush-death.ts" || fail=1; prover_mark "$here/prove-history-flush-death.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-first-prompt-extractor.ts" || fail=1; prover_mark "$here/prove-first-prompt-extractor.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-writer-hardening.ts" || fail=1; prover_mark "$here/prove-writer-hardening.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-record-branch-pruning.ts" || fail=1; prover_mark "$here/prove-record-branch-pruning.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-torn-tail-heal.ts" || fail=1; prover_mark "$here/prove-torn-tail-heal.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-store-not-cross-adopted.ts" || fail=1; prover_mark "$here/prove-store-not-cross-adopted.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-concurrent-chain-fork.ts" || fail=1; prover_mark "$here/prove-concurrent-chain-fork.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-insert-adversarial.ts" || fail=1; prover_mark "$here/prove-insert-adversarial.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-discovery-scan-pool.ts" || fail=1; prover_mark "$here/prove-discovery-scan-pool.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-listing-memo.ts" || fail=1; prover_mark "$here/prove-listing-memo.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-history-read-economy.ts" || fail=1; prover_mark "$here/prove-history-read-economy.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-cleared-mark-wired.ts" || fail=1; prover_mark "$here/prove-cleared-mark-wired.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-store-failure-surfaces.ts" || fail=1; prover_mark "$here/prove-store-failure-surfaces.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-degradation-stated.ts" || fail=1; prover_mark "$here/prove-transcript-degradation-stated.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-tail-reader.ts" || fail=1; prover_mark "$here/prove-transcript-tail-reader.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-consumers-owned.ts" || fail=1; prover_mark "$here/prove-transcript-consumers-owned.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-drain-fault-isolation.ts" || fail=1; prover_mark "$here/prove-drain-fault-isolation.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resume-snapshot-honesty.ts" || fail=1; prover_mark "$here/prove-resume-snapshot-honesty.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-flush-drain-ladder.ts" || fail=1; prover_mark "$here/prove-flush-drain-ladder.ts" "$__t"
if [[ "$fail" == "0" ]]; then echo "✅ SESSIONSTORAGE SUITE GREEN"; exit 0; else
  echo "❌ SESSIONSTORAGE SUITE RED"; exit 1; fi
