#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/anthropic/** src/services/api/client* src/services/api/transportEvidence*
# gate-watch: src/utils/proxy* src/utils/mtls* src/components/messages/SystemAPIErrorMessage*
# scripts/api/run-all.sh — API-client proof suite. Auto-joins the pooled green gate via the glob.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── api-client proofs ──"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-api-parity.ts" || fail=1; prover_mark "$here/prove-api-parity.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transport-truth.ts" || fail=1; prover_mark "$here/prove-transport-truth.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-node-transport-lane.ts" || fail=1; prover_mark "$here/prove-node-transport-lane.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ingestion-truths.ts" || fail=1; prover_mark "$here/prove-ingestion-truths.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-stream-watchdog-posture.ts" || fail=1; prover_mark "scripts/api/prove-stream-watchdog-posture.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-watchdog-pool-reset.ts" || fail=1; prover_mark "scripts/api/prove-watchdog-pool-reset.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-watchdog-timer-economy.ts" || fail=1; prover_mark "scripts/api/prove-watchdog-timer-economy.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-tool-schema-key-memo.ts" || fail=1; prover_mark "scripts/api/prove-tool-schema-key-memo.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-client-contract-door.ts" || fail=1; prover_mark "scripts/api/prove-client-contract-door.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-binding.ts" || fail=1; prover_mark "scripts/api/prove-transcript-binding.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sent-prefix-frozen.ts" || fail=1; prover_mark "scripts/api/prove-sent-prefix-frozen.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-thinking-drop-notice.ts" || fail=1; prover_mark "scripts/api/prove-thinking-drop-notice.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-wire-dump.ts" || fail=1; prover_mark "scripts/api/prove-wire-dump.ts" "$__t"
if [[ "$fail" == "0" ]]; then echo "✅ API SUITE GREEN"; exit 0; else
  echo "❌ API SUITE RED"; exit 1; fi
