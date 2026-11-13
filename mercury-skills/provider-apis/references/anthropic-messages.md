# Anthropic Messages

## Owners and account identity

- `src/services/providers/anthropic/streamCore.ts` builds and consumes Messages; `src/services/api/client.ts` constructs `src/services/providers/anthropic/anthropicClient.ts`.
- `src/services/providers/anthropic/anthropicLogin.ts` and `src/utils/auth.ts` separate subscription OAuth, Console OAuth key minting and pasted API keys. Organization-scoped keys carry workspace identity via `src/services/providers/anthropic/anthropicWorkspace.ts` across Messages, token counting, catalogue and auth headers (exact account-admission and subscription betas remain **UNRESOLVED** publicly).
- `src/services/providers/slotSwitch.ts` retargets subsequent requests only; constructed clients snapshot subscription auth, and `src/services/api/withRetry.ts` re-resolves after a racing 401. Never retarget an in-flight request.
- `src/services/providers/anthropic/requestParams.ts` owns extras, effort, model betas and cache TTL; `src/services/providers/anthropic/cacheAndUsage.ts` owns cache breakpoints and usage folds.

## Replay and settlement

- `src/services/providers/anthropic/messageParams.ts` maps block arrays; `src/services/providers/anthropic/thinkingBinding.ts`, `src/services/providers/anthropic/thinkingDisplay.ts`, `src/services/providers/anthropic/boundPrefixRecord.ts` and `src/services/providers/anthropic/prefixLedger.ts` own signed/redacted thinking and prefix binding. Never serialize signed thinking blocks to plain text. Pair tool results by `tool_use_id`.
- Thinking mode (`adaptive`, `between_tools`, budgeted, disabled), display and `output_config` effort depend on model capabilities; never apply a toggle model's non-thinking setting to an always-thinking model.
- Streaming folds indexed content blocks, settles cumulative `message_delta` usage (never sum deltas), and requires `message_stop`; in-stream errors can follow content. Request deadlines classify in `streamCore.ts` and `src/services/api/reconnectLadder.ts`, distinct from connection timeouts.
- Keep cache read, cache write (by TTL) and uncached input separate. Refresh [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (read 2026-10-26) before moving breakpoints across automatic markers or grouped tool runs.
- `src/services/providers/anthropic/anthropicUsageState.ts` and `src/services/anthropicLimits.ts` track subscription windows (distinct from org API billing). For client-contract updates, see `live-sources.md`.
