#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/attachments/toolManuals.ts
# gate-watch: src/services/providers/anthropic/** src/services/api/client*
# gate-watch: src/services/providers/openai/** src/services/providers/zai/** src/services/providers/gemini/** src/services/providers/openrouter/**
# gate-watch: src/services/api/**
# gate-watch: scripts/lib/* src/*
# gate-watch: src/components/messages/AssistantTextMessage.tsx
# gate-watch: src/constants/*
# gate-watch: src/services/providers/*
# gate-watch: src/utils/*
# gate-watch: src/utils/messages/*
# gate-watch: src/utils/sessionStorage/*
# gate-watch: src/utils/settings/*
# gate-watch: src/services/crewBoard/seam.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/attachments/types.ts
# gate-watch: src/utils/health/sections/memory.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── api-client proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-authentication-retry.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-authentication-retry.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-window-retry.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-window-retry.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-api-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-api-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transport-truth.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transport-truth.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-node-transport-lane.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-node-transport-lane.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-http2-lane.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-http2-lane.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transport-storm.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-transport-storm.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-first-byte-liveness.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-first-byte-liveness.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ingestion-truths.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-ingestion-truths.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-stream-watchdog-posture.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-stream-watchdog-posture.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-watchdog-pool-reset.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-watchdog-pool-reset.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-watchdog-timer-economy.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-watchdog-timer-economy.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-silent-after-headers.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-silent-after-headers.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-anthropic-request-deadline.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-anthropic-request-deadline.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resumed-anthropic-silence.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-resumed-anthropic-silence.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-stream-liveness-words.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-stream-liveness-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-turn-end-typed.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-turn-end-typed.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-tool-schema-key-memo.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-tool-schema-key-memo.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-tool-schema-refs-inlined.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-tool-schema-refs-inlined.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-mcp-schema-normaliser.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-mcp-schema-normaliser.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-client-contract-door.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-client-contract-door.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-model-refusals.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-model-refusals.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-openai-provider-refusal.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-openai-provider-refusal.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-client-contract-heal.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-client-contract-heal.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-client-contract-boot.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-client-contract-boot.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-transcript-binding.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-transcript-binding.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-instructions-heading.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-instructions-heading.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-credential-refusal-words.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-credential-refusal-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sent-prefix-frozen.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-sent-prefix-frozen.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-cache-prefix-stable.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-cache-prefix-stable.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-cache-divergence-replay.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-cache-divergence-replay.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-switch-row-says-default.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-switch-row-says-default.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-memory-save-keeps-prefix.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-memory-save-keeps-prefix.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-dead-thinking-in-turn.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-dead-thinking-in-turn.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-thinking-drop-notice.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-thinking-drop-notice.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-switch-notice-lands.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-switch-notice-lands.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-wire-dump.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-wire-dump.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-typed-word-is-a-word.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-typed-word-is-a-word.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-opus-55-display.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-opus-55-display.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-tell-engine-switch.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-tell-engine-switch.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-model-switch-off-the-wire.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-model-switch-off-the-wire.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-prefix-ledger.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-prefix-ledger.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resume-history-bytes.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-resume-history-bytes.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-prefix-record-life.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-prefix-record-life.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-restart-keeps-thinking.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-restart-keeps-thinking.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resumed-agent-roster.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-resumed-agent-roster.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resumed-agent-context.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-resumed-agent-context.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-agent-record-resume.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-agent-record-resume.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-resumed-roster-marks.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-resumed-roster-marks.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-lawful-change-owners.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-lawful-change-owners.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-recovery-budget.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-recovery-budget.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-reconnect-ladder.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-reconnect-ladder.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-stream-cut-road.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-stream-cut-road.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-stream-liveness-tap.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-stream-liveness-tap.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-patience-numbers.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-patience-numbers.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-patience-every-route.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-patience-every-route.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-patience-road-anthropic.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-patience-road-anthropic.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-patience-road-openai.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-patience-road-openai.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-empty-reply-cases.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-empty-reply-cases.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-empty-reply-cases-zai.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-empty-reply-cases-zai.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-empty-reply-nudge.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-empty-reply-nudge.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-patience-road-openaicompat.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-patience-road-openaicompat.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-patience-road-zai.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-patience-road-zai.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-image-refusal-recovery.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-image-refusal-recovery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-many-images-cap.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-many-images-cap.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hosted-image-history.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-hosted-image-history.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-many-images-rescue.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-many-images-rescue.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-fitted-images-keep-later-thinking.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-fitted-images-keep-later-thinking.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-field-e004-image-sizer.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-field-e004-image-sizer.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sized-copy-follows-limits.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-sized-copy-follows-limits.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-empty-text-block.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-empty-text-block.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-side-question-effort.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-side-question-effort.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-unrecognised-4xx-sentence.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-unrecognised-4xx-sentence.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-openai-400-capture-and-resume.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-openai-400-capture-and-resume.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-provider-wait-words.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-provider-wait-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-quiet-wire.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-quiet-wire.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-headless-wire.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-headless-wire.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-overload-no-retry.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-overload-no-retry.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-retry-timeline-anthropic.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-retry-timeline-anthropic.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-retry-timeline-openai.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-retry-timeline-openai.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-retry-timeline-openaicompat.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-retry-timeline-openaicompat.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-retry-timeline-zai.ts" || { __rc=$?; fail=1; }; prover_mark "scripts/api/prove-retry-timeline-zai.ts" "$__t" "$__rc"
if [[ "$fail" == "0" ]]; then echo "✅ API SUITE GREEN"; exit 0; else
  echo "❌ API SUITE RED"; exit 1; fi
