#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/sessionStorage/** src/utils/sessionStoragePortable.ts src/history.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── session-persistence proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sessionstorage-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-sessionstorage-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-key-canonical.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-key-canonical.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-home-fold.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-home-fold.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-key-stability.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-key-stability.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-project-recognition.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-project-recognition.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-history-flush-death.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-history-flush-death.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-first-prompt-extractor.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-first-prompt-extractor.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-writer-hardening.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-writer-hardening.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-record-branch-pruning.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-record-branch-pruning.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-torn-tail-heal.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-torn-tail-heal.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-store-not-cross-adopted.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-store-not-cross-adopted.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-concurrent-chain-fork.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-concurrent-chain-fork.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-decision-rows-thread.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-decision-rows-thread.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-insert-adversarial.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-insert-adversarial.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-discovery-scan-pool.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-discovery-scan-pool.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-listing-memo.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-listing-memo.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-history-read-economy.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-history-read-economy.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-cleared-mark-wired.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-cleared-mark-wired.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-store-failure-surfaces.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-store-failure-surfaces.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-degradation-stated.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transcript-degradation-stated.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-tail-reader.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transcript-tail-reader.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-consumers-owned.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transcript-consumers-owned.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-drain-fault-isolation.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-drain-fault-isolation.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resume-snapshot-honesty.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-resume-snapshot-honesty.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-flush-drain-ladder.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-flush-drain-ladder.ts" "$__t" "$__rc"
if [[ "$fail" == "0" ]]; then echo "✅ SESSIONSTORAGE SUITE GREEN"; exit 0; else
  echo "❌ SESSIONSTORAGE SUITE RED"; exit 1; fi
