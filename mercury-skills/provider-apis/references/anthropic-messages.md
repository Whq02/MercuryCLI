# Anthropic Messages

Historical CODE map, 2026-10-26; inspect the relevant owner before changing it. Vendor readings are indexed in `live-sources.md`. The entry holds shared invariants; this reference holds Messages-specific distinctions.

## Owners and account identity

- `src/services/providers/anthropic/streamCore.ts` builds/consumes Messages. `src/services/api/client.ts` constructs `src/services/providers/anthropic/anthropicClient.ts`; its stream/wire siblings own the transport, not other providers' roads.
- `src/services/providers/anthropic/anthropicLogin.ts` and `src/utils/auth.ts` distinguish subscription OAuth, Console OAuth key minting and pasted keys. Workspace identity travels with an organization-scoped key through `src/services/providers/anthropic/anthropicWorkspace.ts`: Messages, token counting, catalogue and auth headers need the same binding. Public Messages docs establish the workspace header, not every account-admission rule or subscription beta (**UNRESOLVED** externally).
- `src/services/providers/slotSwitch.ts` changes new requests. The constructed client snapshots subscription auth; `src/services/api/withRetry.ts` re-resolves the client after a racing 401. Do not retarget an in-flight request's identity.
- `src/services/providers/anthropic/requestParams.ts` owns extras, effort, model betas and cache lifetime; `src/services/providers/anthropic/cacheAndUsage.ts` owns breakpoint placement and usage folds.

## Replay and settlement

`src/services/providers/anthropic/messageParams.ts` maps block arrays; `src/services/providers/anthropic/thinkingBinding.ts`, `src/services/providers/anthropic/thinkingDisplay.ts`, `src/services/providers/anthropic/boundPrefixRecord.ts` and `src/services/providers/anthropic/prefixLedger.ts` own signed/redacted thinking and its prefix. Text serialization is not replay of signed blocks. Pair tool results by tool_use_id.

Thinking mode/display and output_config effort depend on model support. Adaptive, between_tools, legacy budgeted thinking and disabled are not interchangeable; an always-on model cannot be made nonthinking by borrowing a toggle model's recipe. Read the current effort/thinking page rather than maintaining a second enum.

Streaming starts the message and indexed content blocks, folds deltas and stops blocks, then settles message_delta usage and message_stop. Usage deltas are cumulative, not additive samples. In-stream errors can follow content. Request-deadline classification belongs to the client/streamCore and `src/services/api/reconnectLadder.ts`; a deadline must not borrow an earlier connection-timeout diagnostic.

Read actual cache placement before editing. Cache read, cache creation (including lifetime breakdown) and uncached input remain separate. **Historical LIVE reading 2026-10-26:** [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) documents ephemeral lifetimes and breakpoint/lookback limits. Refresh the exact counting rule when changing placement; automatic markers and grouped tool runs make a simple per-block count misleading. Retries are new requests, not guaranteed cheap continuations.

`src/services/providers/anthropic/anthropicUsageState.ts` and `src/services/anthropicLimits.ts` hold subscription observations; they are not API organization billing. For release-day subscription client-contract work, use the constant owner and clock procedure in the vendor index, not a copied CLI version.
