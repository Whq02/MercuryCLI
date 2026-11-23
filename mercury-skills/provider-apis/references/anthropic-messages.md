# Anthropic Messages

## Owners and account identity

- `src/models/roads/anthropic/streamCore.ts` builds and consumes Messages; `src/models/roads/anthropic/anthropicClientFactory.ts` constructs `src/models/roads/anthropic/anthropicClient.ts`.
- `src/models/roads/anthropic/anthropicLogin.ts` and `src/models/sign-in/credentials/auth.ts` separate subscription OAuth, Console OAuth key minting and pasted API keys. Organization-scoped keys carry workspace identity via `src/models/roads/anthropic/anthropicWorkspace.ts` across Messages, token counting, catalogue and auth headers (exact account-admission and subscription betas remain **UNRESOLVED** publicly).
- `src/models/roads/slotSwitch.ts` retargets subsequent requests only; constructed clients snapshot subscription auth, and `src/engine/requests/withRetry.ts` re-resolves after a racing 401. Never retarget an in-flight request.
- `src/models/roads/anthropic/requestParams.ts` owns extras, effort, model betas and cache TTL; `src/models/roads/anthropic/cacheAndUsage.ts` owns cache breakpoints and usage folds.

## Replay and settlement

- `src/models/roads/anthropic/messageParams.ts` maps block arrays; `src/models/roads/anthropic/thinkingBinding.ts`, `src/models/roads/anthropic/thinkingDisplay.ts`, `src/models/roads/anthropic/boundPrefixRecord.ts` and `src/models/roads/anthropic/prefixLedger.ts` own signed/redacted thinking and prefix binding. Never serialize signed thinking blocks to plain text. Pair tool results by `tool_use_id`.
- Thinking mode (`adaptive`, `between_tools`, budgeted, disabled), display and `output_config` effort depend on model capabilities; never apply a toggle model's non-thinking setting to an always-thinking model.
- Streaming folds indexed content blocks, settles cumulative `message_delta` usage (never sum deltas), and requires `message_stop`; in-stream errors can follow content. Request deadlines classify in `streamCore.ts` and `src/engine/requests/reconnectLadder.ts`, distinct from connection timeouts.
- Keep cache read, cache write (by TTL) and uncached input separate. Refresh [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (read 2026-10-26) before moving breakpoints across automatic markers or grouped tool runs.
- `src/models/roads/anthropic/anthropicUsageState.ts` and `src/models/roads/anthropic/anthropicLimits.ts` track subscription windows (distinct from org API billing). For client-contract updates, see `live-sources.md`.
